/**
 * Правила «если → то»: горячие папки с цепочкой действий.
 *
 * Правило следит за папкой. Когда в ней появляется новый файл, он проходит
 * цепочку шагов: условие («если») останавливает цепочку, если файл не подошёл;
 * действия (переместить, скопировать, переименовать, упаковать в zip) меняют
 * текущий путь файла, и следующий шаг работает уже с результатом.
 *
 * Намеренно нет шагов «удалить» и «запустить программу»: правило срабатывает
 * само, без подтверждения, поэтому оно не должно уничтожать данные или
 * исполнять произвольные команды.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import AdmZip from "adm-zip";
import config from "./config";
import logger from "./logger";

export type StepType = "if" | "move" | "copy" | "rename" | "zip";

export interface Step {
  id: string;
  type: StepType;
  params: Record<string, string>;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  folder: string;
  steps: Step[];
  createdAt: number;
}

export interface RunResult {
  /** Итоговый путь файла (или исходный, если цепочка остановилась на условии). */
  path: string;
  /** false — условие «если» не пропустило файл. */
  completed: boolean;
  log: string[];
}

const STEP_TYPES: StepType[] = ["if", "move", "copy", "rename", "zip"];

/** Подстановки в шаблонах: {name} {ext} {date} {year} {month} {day} {n}. */
export function expand(template: string, file: string, now: Date, n = 1): string {
  const ext = path.extname(file);
  const pad = (v: number): string => String(v).padStart(2, "0");
  const vars: Record<string, string> = {
    name: path.basename(file, ext),
    ext,
    extnodot: ext.replace(/^\./, "").toLowerCase(),
    year: String(now.getFullYear()),
    month: pad(now.getMonth() + 1),
    day: pad(now.getDate()),
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    n: String(n),
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** Имя файла без запрещённых символов Windows. */
function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "") || "file";
}

/** Свободное имя в папке: «a.txt» → «a (2).txt». */
function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

/** Проверка условия «если»; все указанные параметры должны сойтись. */
export function checkCondition(params: Record<string, string>, file: string, size: number): boolean {
  const ext = path.extname(file).replace(/^\./, "").toLowerCase();
  const exts = (params.ext ?? "")
    .split(/[,\s;]+/)
    .map((e) => e.replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  if (exts.length && !exts.includes(ext)) return false;
  if (params.nameRegex) {
    try {
      if (!new RegExp(params.nameRegex, "i").test(path.basename(file))) return false;
    } catch {
      return false; // некорректное выражение — файл не пропускаем
    }
  }
  const mb = size / (1024 * 1024);
  if (params.minSizeMb && mb < Number(params.minSizeMb)) return false;
  if (params.maxSizeMb && mb > Number(params.maxSizeMb)) return false;
  return true;
}

function requireAbsolute(dir: string | undefined, what: string): string {
  if (!dir || !path.isAbsolute(dir)) throw new Error(`${what}: нужен абсолютный путь`);
  return dir;
}

/** Выполняет цепочку над одним файлом. Ошибка шага прерывает цепочку и пробрасывается. */
export function runChain(file: string, steps: Step[], now = new Date()): RunResult {
  let current = file;
  const log: string[] = [];
  for (const step of steps) {
    const p = step.params ?? {};
    switch (step.type) {
      case "if": {
        const size = fs.statSync(current).size;
        if (!checkCondition(p, current, size)) {
          log.push(`если: ${path.basename(current)} не подошёл`);
          return { path: current, completed: false, log };
        }
        log.push(`если: ${path.basename(current)} подошёл`);
        break;
      }
      case "move":
      case "copy": {
        const dir = requireAbsolute(expand(p.dest ?? "", current, now), step.type);
        fs.mkdirSync(dir, { recursive: true });
        const target = uniquePath(dir, path.basename(current));
        if (step.type === "copy") fs.copyFileSync(current, target);
        else {
          try {
            fs.renameSync(current, target);
          } catch (e) {
            // перенос между дисками: копия + удаление исходного
            if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
            fs.copyFileSync(current, target);
            fs.unlinkSync(current);
          }
        }
        log.push(`${step.type === "copy" ? "копия" : "перенос"}: ${target}`);
        current = target;
        break;
      }
      case "rename": {
        const name = safeFileName(expand(p.template || "{name}{ext}", current, now));
        const target = uniquePath(path.dirname(current), name);
        fs.renameSync(current, target);
        log.push(`переименован: ${path.basename(target)}`);
        current = target;
        break;
      }
      case "zip": {
        const dir = p.dest
          ? requireAbsolute(expand(p.dest, current, now), "zip")
          : path.dirname(current);
        fs.mkdirSync(dir, { recursive: true });
        const zip = new AdmZip();
        zip.addLocalFile(current);
        const target = uniquePath(dir, `${path.basename(current, path.extname(current))}.zip`);
        zip.writeZip(target);
        log.push(`zip: ${target}`);
        current = target;
        break;
      }
      default:
        throw new Error(`неизвестный шаг: ${String((step as Step).type)}`);
    }
  }
  return { path: current, completed: true, log };
}

/* ------------------------------ Хранение ------------------------------ */

const file = (): string => path.join(config.DIRS.storage, "automation-rules.json");

export function sanitizeRule(input: Partial<Rule>, id?: string): Rule {
  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .filter((s) => s && STEP_TYPES.includes(s.type))
    .slice(0, 20)
    .map((s) => ({
      id: String(s.id || crypto.randomBytes(4).toString("hex")),
      type: s.type,
      params: Object.fromEntries(
        Object.entries(s.params ?? {}).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 500)]),
      ),
    }));
  return {
    id: id ?? String(input.id || crypto.randomBytes(6).toString("hex")),
    name: String(input.name || "").trim().slice(0, 80) || "Правило",
    enabled: input.enabled !== false,
    folder: String(input.folder || "").trim(),
    steps,
    createdAt: Number(input.createdAt) || Date.now(),
  };
}

export function listRules(): Rule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(raw) ? raw.map((r) => sanitizeRule(r, r.id)) : [];
  } catch {
    return [];
  }
}

function writeRules(rules: Rule[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(rules, null, 2), "utf8");
}

export function saveRule(input: Partial<Rule>): Rule {
  const rules = listRules();
  const idx = input.id ? rules.findIndex((r) => r.id === input.id) : -1;
  const rule = sanitizeRule(input, idx >= 0 ? rules[idx].id : undefined);
  if (!path.isAbsolute(rule.folder)) throw new Error("folder_not_absolute");
  if (idx >= 0) {
    rule.createdAt = rules[idx].createdAt;
    rules[idx] = rule;
  } else rules.push(rule);
  writeRules(rules);
  restartWatchers();
  return rule;
}

export function deleteRule(id: string): boolean {
  const rules = listRules();
  const next = rules.filter((r) => r.id !== id);
  if (next.length === rules.length) return false;
  writeRules(next);
  restartWatchers();
  return true;
}

/* -------------------------------- Журнал -------------------------------- */

export interface RunLogEntry {
  at: number;
  ruleId: string;
  ruleName: string;
  file: string;
  ok: boolean;
  completed: boolean;
  message: string;
}
const runLog: RunLogEntry[] = [];
export const getRunLog = (): RunLogEntry[] => runLog;

function pushLog(e: RunLogEntry): void {
  runLog.unshift(e);
  if (runLog.length > 100) runLog.length = 100;
}

/* ------------------------------- Наблюдение ------------------------------- */

const TEMP_EXT = /\.(crdownload|part|tmp|download|partial)$/i;
const watchers = new Map<string, fs.FSWatcher>();
const handled = new Map<string, number>();

/** Файл дописан: размер не меняется между двумя замерами. */
async function isStable(p: string, waitMs = 700): Promise<boolean> {
  try {
    const a = fs.statSync(p);
    await new Promise((r) => setTimeout(r, waitMs));
    const b = fs.statSync(p);
    return a.size === b.size && a.mtimeMs === b.mtimeMs && b.size > 0;
  } catch {
    return false;
  }
}

export async function processFile(rule: Rule, p: string): Promise<RunLogEntry> {
  const base: Omit<RunLogEntry, "ok" | "completed" | "message"> = {
    at: Date.now(),
    ruleId: rule.id,
    ruleName: rule.name,
    file: p,
  };
  try {
    const r = runChain(p, rule.steps);
    const entry = { ...base, ok: true, completed: r.completed, message: r.log.join(" → ") };
    pushLog(entry);
    return entry;
  } catch (e) {
    const entry = { ...base, ok: false, completed: false, message: String((e as Error).message) };
    pushLog(entry);
    logger.warn("automationRules.failed", { rule: rule.name, file: p, error: entry.message });
    return entry;
  }
}

function watch(rule: Rule): void {
  if (!rule.enabled || !rule.steps.length || !fs.existsSync(rule.folder)) return;
  try {
    const w = fs.watch(rule.folder, { persistent: false }, (_ev, name) => {
      if (!name) return;
      const full = path.join(rule.folder, name.toString());
      if (name.toString().startsWith(".") || TEMP_EXT.test(full)) return;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        return;
      }
      if (!st.isFile()) return;
      const key = `${rule.id}|${full}|${Math.floor(st.mtimeMs)}`;
      if (handled.has(key)) return;
      handled.set(key, Date.now());
      if (handled.size > 2000) handled.delete(handled.keys().next().value as string);
      void isStable(full).then((ok) => {
        if (ok) void processFile(rule, full);
        else handled.delete(key);
      });
    });
    w.on("error", () => watchers.delete(rule.id));
    watchers.set(rule.id, w);
  } catch (e) {
    logger.warn("automationRules.watch", { folder: rule.folder, error: String((e as Error).message) });
  }
}

export function restartWatchers(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  for (const r of listRules()) watch(r);
}

export function startRules(): void {
  restartWatchers();
}

export function stopRules(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
}
