/**
 * «Щит для ИИ»: слой перед облачными провайдерами. Перед отправкой прячет
 * секреты (ключи, токены, номера карт, пароли) за метками вида «[КАРТА_1]» и
 * ведёт журнал «кто что получал» — без содержимого, только метаданные.
 *
 * Логика — чистые функции; хранение журнала — JSONL в каталоге storage.
 * Метки возвращаются в ответе модели (не потоковом) на исходные значения.
 */
import fs from "fs";
import path from "path";
import { luhn } from "./secretFinder";

export type ShieldKind =
  | "private-key"
  | "card"
  | "api-key"
  | "jwt"
  | "password"
  | "token"
  | "email"
  | "phone"
  | "ip"
  | "name";

export interface ShieldOptions {
  /** Прятать также e-mail, телефоны и IP (выключено по умолчанию). */
  pii?: boolean;
  /** Прятать ФИО по характерным шаблонам («Иванов И. И.», «Пётр Сергеевич»); по умолчанию включено. */
  names?: boolean;
  /** Имена, найденные локальной моделью: заменяются везде, где встречаются. */
  extraNames?: string[];
}

export interface ShieldResult {
  text: string;
  /** Сколько значений каждого вида спрятано. */
  found: Partial<Record<ShieldKind, number>>;
  /** Метка → исходное значение (для обратной подстановки). */
  map: Record<string, string>;
}

const LABELS: Record<ShieldKind, string> = {
  "private-key": "КЛЮЧ_ПРИВАТНЫЙ",
  card: "КАРТА",
  "api-key": "API_КЛЮЧ",
  jwt: "JWT",
  password: "ПАРОЛЬ",
  token: "ТОКЕН",
  email: "ПОЧТА",
  phone: "ТЕЛЕФОН",
  ip: "IP",
  name: "ИМЯ",
};

interface Rule {
  kind: ShieldKind;
  re: RegExp;
  group?: number;
  accept?: (m: RegExpExecArray) => boolean;
  pii?: boolean;
}

// Порядок важен: более специфичные правила идут раньше общих.
const RULES: Rule[] = [
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: "api-key",
    re: /(?<![\w-])(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g,
  },
  { kind: "jwt", re: /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g },
  {
    kind: "card",
    re: /(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g,
    accept: (m) => luhn(m[0].replace(/[ -]/g, "")),
  },
  {
    kind: "password",
    re: /(?:парол[ьяю]|password|passwd|pwd|secret|token|токен)\s*[:=]\s*(\S{3,})/gi,
    group: 1,
  },
  {
    kind: "token",
    re: /(?<![\w-])[A-Za-z0-9_-]{32,}(?![\w-])/g,
    accept: (m) => /\d/.test(m[0]) && /[A-Za-z]/.test(m[0]),
  },
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, pii: true },
  {
    kind: "phone",
    re: /(?<![\d])(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?![\d])/g,
    pii: true,
  },
  {
    kind: "ip",
    re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g,
    pii: true,
  },
];

/** ФИО по шаблонам: фамилия + инициалы, инициалы + фамилия, имя/фамилия + отчество. */
const NAME_RULES: RegExp[] = [
  /(?<![\p{L}])[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.(?![\p{L}])/gu,
  /(?<![\p{L}])[А-ЯЁ]\.\s?[А-ЯЁ]\.\s?[А-ЯЁ][а-яё]{2,}(?![\p{L}])/gu,
  /(?<![\p{L}])(?:[А-ЯЁ][а-яё]{2,}\s+){1,2}[А-ЯЁ][а-яё]+(?:(?:ович|евич|ьич)(?:а|у|ем|е)?|(?:овн|евн|ичн|иничн)(?:а|ы|е|у|ой))(?![\p{L}])/gu,
];

const PLACEHOLDER = /\[[A-ZА-ЯЁ_]+_\d+\]/;

/** Прячет секреты в тексте. Один и тот же секрет получает одну и ту же метку. */
export function shieldText(
  input: string,
  opts: ShieldOptions = {},
  state?: { counters: Record<string, number>; byValue: Map<string, string> },
): ShieldResult {
  const counters = state?.counters ?? {};
  const byValue = state?.byValue ?? new Map<string, string>();
  const found: ShieldResult["found"] = {};
  const map: Record<string, string> = {};
  let text = String(input ?? "");

  for (const rule of RULES) {
    if (rule.pii && !opts.pii) continue;
    text = text.replace(rule.re, (...args: unknown[]) => {
      const groups = args.slice(0, -2) as string[];
      const m = Object.assign(groups, { index: args[args.length - 2] as number }) as unknown as RegExpExecArray;
      if (rule.accept && !rule.accept(m)) return m[0];
      const full = m[0];
      const secret = rule.group ? m[rule.group] : full;
      if (!secret || PLACEHOLDER.test(secret)) return full;
      const key = `${rule.kind}\u0000${secret}`;
      let label = byValue.get(key);
      if (!label) {
        counters[rule.kind] = (counters[rule.kind] ?? 0) + 1;
        label = `[${LABELS[rule.kind]}_${counters[rule.kind]}]`;
        byValue.set(key, label);
      }
      map[label] = secret;
      found[rule.kind] = (found[rule.kind] ?? 0) + 1;
      return rule.group ? full.replace(secret, label) : label;
    });
  }
  const mask = (secret: string, kind: ShieldKind): string => {
    // имена сравниваем без учёта регистра: «мария кузнецова» и «Мария Кузнецова» — один человек
    const key = `${kind}\u0000${kind === "name" ? secret.toLowerCase() : secret}`;
    let label = byValue.get(key);
    if (!label) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      label = `[${LABELS[kind]}_${counters[kind]}]`;
      byValue.set(key, label);
    }
    if (!(label in map)) map[label] = secret;
    found[kind] = (found[kind] ?? 0) + 1;
    return label;
  };
  if (opts.names !== false) {
    for (const re of NAME_RULES) text = text.replace(re, (m) => mask(m, "name"));
  }
  for (const nm of opts.extraNames ?? []) {
    const name = nm.trim();
    if (name.length < 3) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![\\p{L}])${esc}(?![\\p{L}])`, "giu"), (m) => mask(m, "name"));
  }
  return { text, found, map };
}

/** Список имён из ответа локальной модели (JSON-массив строк или строки через запятую/перевод строки). */
export function parseNameList(raw: string): string[] {
  const text = String(raw ?? "");
  let items: unknown[] = [];
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a >= 0 && b > a) {
    try {
      const parsed = JSON.parse(text.slice(a, b + 1));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      /* ниже разберём как список строк */
    }
  }
  if (!items.length) items = text.split(/[\r\n,;]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const s = String(it ?? "").replace(/^[\s\-*•\d.)"«]+|[\s"»]+$/g, "").trim();
    if (s.length < 3 || s.length > 60 || !/^\p{Lu}/u.test(s) || /[\d@:/]/.test(s)) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 30) break;
  }
  return out;
}

export interface ShieldedMessages<M> {
  messages: M[];
  found: Partial<Record<ShieldKind, number>>;
  map: Record<string, string>;
}

/** Применяет щит ко всем сообщениям; метки сквозные для всего запроса. */
export function shieldMessages<M extends { text: string }>(
  messages: M[],
  opts: ShieldOptions = {},
): ShieldedMessages<M> {
  const state = { counters: {} as Record<string, number>, byValue: new Map<string, string>() };
  const found: ShieldedMessages<M>["found"] = {};
  const map: Record<string, string> = {};
  const out = messages.map((m) => {
    const r = shieldText(m.text, opts, state);
    for (const [k, n] of Object.entries(r.found)) {
      const kk = k as ShieldKind;
      found[kk] = (found[kk] ?? 0) + (n ?? 0);
    }
    Object.assign(map, r.map);
    return r.text === m.text ? m : { ...m, text: r.text };
  });
  return { messages: out, found, map };
}

/** Возвращает исходные значения на место меток. */
export function restoreText(text: string, map: Record<string, string>): string {
  let out = String(text ?? "");
  for (const [label, value] of Object.entries(map)) out = out.split(label).join(value);
  return out;
}

// ---------------- журнал «кто что получал» ----------------

export interface AuditEntry {
  at: number;
  provider: string;
  model: string;
  /** Локальный провайдер: данные не покидают компьютер. */
  local: boolean;
  messages: number;
  chars: number;
  images: number;
  /** Сколько значений скрыто щитом, по видам. */
  hidden: Partial<Record<ShieldKind, number>>;
  /** Начало последнего сообщения пользователя (уже после маскировки). */
  preview: string;
}

export const MAX_AUDIT = 2000;
export const PREVIEW_CHARS = 80;

export function makeEntry(p: {
  provider: string;
  model: string;
  local: boolean;
  messages: { role: string; text: string; images?: string[] }[];
  hidden: AuditEntry["hidden"];
  at?: number;
  preview?: boolean;
}): AuditEntry {
  const last = [...p.messages].reverse().find((m) => m.role === "user");
  return {
    at: p.at ?? Date.now(),
    provider: p.provider,
    model: p.model,
    local: p.local,
    messages: p.messages.length,
    chars: p.messages.reduce((n, m) => n + (m.text?.length ?? 0), 0),
    images: p.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0),
    hidden: p.hidden,
    preview:
      p.preview === false || !last ? "" : last.text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
  };
}

export interface AuditSummary {
  total: number;
  cloud: number;
  local: number;
  chars: number;
  hidden: number;
  byProvider: { provider: string; requests: number; chars: number; hidden: number; local: boolean }[];
}

export function summarize(list: AuditEntry[]): AuditSummary {
  const by = new Map<string, AuditSummary["byProvider"][number]>();
  let chars = 0;
  let hidden = 0;
  let local = 0;
  for (const e of list) {
    const h = Object.values(e.hidden).reduce((a, b) => a + (b ?? 0), 0);
    chars += e.chars;
    hidden += h;
    if (e.local) local++;
    const row = by.get(e.provider) ?? {
      provider: e.provider,
      requests: 0,
      chars: 0,
      hidden: 0,
      local: e.local,
    };
    row.requests++;
    row.chars += e.chars;
    row.hidden += h;
    by.set(e.provider, row);
  }
  return {
    total: list.length,
    cloud: list.length - local,
    local,
    chars,
    hidden,
    byProvider: [...by.values()].sort((a, b) => b.requests - a.requests),
  };
}

function auditFile(): string {
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "ai-audit.jsonl");
}

export function appendAudit(e: AuditEntry, file = auditFile()): void {
  try {
    fs.appendFileSync(file, JSON.stringify(e) + "\n", "utf8");
    // Изредка подрезаем журнал, чтобы он не рос бесконечно.
    if (Math.random() < 0.02) {
      const all = loadAudit(Infinity, file);
      if (all.length > MAX_AUDIT)
        fs.writeFileSync(
          file,
          all
            .slice(-MAX_AUDIT)
            .map((x) => JSON.stringify(x))
            .join("\n") + "\n",
          "utf8",
        );
    }
  } catch {
    /* журнал не должен ломать отправку */
  }
}

export function loadAudit(limit = 200, file = auditFile()): AuditEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (e && typeof e.at === "number" && typeof e.provider === "string") out.push(e);
    } catch {
      /* битая строка */
    }
  }
  return Number.isFinite(limit) ? out.slice(-limit) : out;
}

export function clearAudit(file = auditFile()): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* файла нет */
  }
}
