/**
 * Настройки почты (таблица kv в mail.db): уведомления, внешний вид, трекинг, ИИ, MCP,
 * OAuth-клиенты, умные папки, закрепления, автоответчики.
 */
import crypto from "crypto";
import { mailDb } from "./mailDb";

export interface AutoReply {
  enabled: boolean;
  subject: string;
  body: string;
  /** Начало и конец периода (мс); 0 — без ограничения. */
  from: number;
  to: number;
  /** Отвечать только тем, кто уже есть в переписке. */
  onlyKnown: boolean;
}

export interface SmartFolder {
  id: string;
  name: string;
  query: string;
  account: string;
}

export interface PinnedFolder {
  account: string;
  path: string;
  name: string;
}

export interface MailSettings {
  notify: {
    enabled: boolean;
    preview: boolean;
    sound: boolean;
    onlyInbox: boolean;
    badge: boolean;
    quietEnabled: boolean;
    quietFrom: string;
    quietTo: string;
    muted: string[];
  };
  appearance: {
    bodyTheme: "auto" | "light" | "dark";
    density: "cozy" | "compact";
    fontSize: number;
    avatars: "initials" | "gravatar" | "off";
    threads: boolean;
    sendDelaySec: number;
    refreshOnFocus: boolean;
    markReadOnOpen: boolean;
    composeMarkdown: boolean;
    loadImages: boolean;
    accountTags: boolean;
  };
  tracking: { enabled: boolean; base: string; key: string; opens: boolean; clicks: boolean };
  ai: {
    enabled: boolean;
    language: string;
    tone: string;
    /** embedding — локально (EmbeddingGemma), provider — облачный провайдер, llamacpp — локальная LLM. */
    engine: "embedding" | "provider" | "llamacpp";
    providerId: string;
    model: string;
    /** ai | local | google | mymemory | libre | lingva (как в RSS). */
    translateEngine: string;
  };
  mcp: { enabled: boolean; key: string; allowSend: boolean; port: number };
  oauth: { googleClientId: string; googleClientSecret: string; microsoftClientId: string };
  smartFolders: SmartFolder[];
  pinned: PinnedFolder[];
  autoReply: Record<string, AutoReply>;
}

export const DEFAULTS: MailSettings = {
  notify: {
    enabled: true,
    preview: true,
    sound: true,
    onlyInbox: true,
    badge: true,
    quietEnabled: false,
    quietFrom: "22:00",
    quietTo: "08:00",
    muted: [],
  },
  appearance: {
    bodyTheme: "auto",
    density: "cozy",
    fontSize: 14,
    avatars: "initials",
    threads: true,
    sendDelaySec: 8,
    refreshOnFocus: true,
    markReadOnOpen: true,
    loadImages: false,
    accountTags: true,
    composeMarkdown: false,
  },
  tracking: { enabled: false, base: "", key: "", opens: true, clicks: true },
  ai: {
    enabled: true,
    language: "",
    tone: "neutral",
    engine: "embedding",
    providerId: "",
    model: "",
    translateEngine: "local",
  },
  mcp: { enabled: false, key: "", allowSend: false, port: 38417 },
  oauth: { googleClientId: "", googleClientSecret: "", microsoftClientId: "" },
  smartFolders: [],
  pinned: [],
  autoReply: {},
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function merge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : (patch as T)) ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] =
      k in base && isObj((base as Record<string, unknown>)[k]) && isObj(v)
        ? merge((base as Record<string, unknown>)[k], v)
        : v;
  }
  return out as T;
}

let cache: MailSettings | null = null;

export function getSettings(): MailSettings {
  if (cache) return cache;
  const r = mailDb().prepare("SELECT value FROM kv WHERE key = 'settings'").get() as
    { value: string } | undefined;
  let stored: unknown = {};
  try {
    stored = r ? JSON.parse(r.value) : {};
  } catch {
    /* повреждённые настройки — берём значения по умолчанию */
  }
  cache = merge(DEFAULTS, stored);
  return cache;
}

export function setSettings(patch: unknown): MailSettings {
  const next = merge(getSettings(), patch);
  // массивы и словари заменяются целиком (merge рекурсивен только по объектам-секциям)
  if (isObj(patch)) {
    for (const k of ["smartFolders", "pinned", "autoReply"] as const) {
      if (k in patch)
        (next as unknown as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
    if (isObj(patch.notify) && Array.isArray(patch.notify.muted))
      next.notify.muted = patch.notify.muted as string[];
  }
  cache = next;
  mailDb()
    .prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)")
    .run(JSON.stringify(next));
  return next;
}

/** Публичный вид: секреты (ключи MCP/OAuth/трекинга) показываем только как «заданы». */
export function publicSettings(): MailSettings & { _secrets: Record<string, boolean> } {
  const s = getSettings();
  return {
    ...s,
    mcp: { ...s.mcp, key: s.mcp.key ? "••••••••" : "" },
    tracking: { ...s.tracking, key: s.tracking.key ? "••••••••" : "" },
    oauth: { ...s.oauth, googleClientSecret: s.oauth.googleClientSecret ? "••••••••" : "" },
    _secrets: {
      mcpKey: !!s.mcp.key,
      trackingKey: !!s.tracking.key,
      googleSecret: !!s.oauth.googleClientSecret,
    },
  };
}

export function newKey(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Применяет патч, не затирая секреты значением-маской из публичного вида. */
export function setSettingsFromClient(patch: Record<string, unknown>): MailSettings {
  const clean = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
  delete clean._secrets;
  const strip = (obj: unknown, key: string) => {
    if (isObj(obj) && obj[key] === "••••••••") delete obj[key];
  };
  strip(clean.mcp, "key");
  strip(clean.tracking, "key");
  strip(clean.oauth, "googleClientSecret");
  return setSettings(clean);
}
