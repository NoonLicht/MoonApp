/**
 * Ghost Context: по тому, над чем вы сейчас работаете (заголовок активного окна
 * и/или выделенный текст внутри приложения), подбирает связанные заметки,
 * лекции, траты и задачи. Здесь — чистая логика: очистка заголовка, запрос,
 * группировка результатов. Поиск и чтение окна — в routes/ghost.ts.
 *
 * Приватность: функция выключена по умолчанию; заголовок окна не покидает
 * компьютер (поиск локальный) и не сохраняется; окна менеджеров паролей и
 * банков игнорируются.
 */
import { tokenize } from "./hybridRank";

/** Заголовки, по которым искать бессмысленно. */
const GENERIC = new Set([
  "новая вкладка",
  "new tab",
  "проводник",
  "explorer",
  "пуск",
  "start",
  "рабочий стол",
  "desktop",
  "параметры",
  "settings",
  "диспетчер задач",
  "task manager",
  "program manager",
]);

/** Окна, содержимое которых нельзя использовать в запросах. */
const SENSITIVE =
  /парол|password|keepass|bitwarden|1password|lastpass|банк|bank|кошел|wallet|sberbank|tinkoff|т-банк/i;

/** Хвосты вида « - Google Chrome», « — Mozilla Firefox», « - Word». */
const APP_TAIL =
  /\s+[-–—|]\s+(?:google chrome|microsoft edge|mozilla firefox|firefox|opera|yandex|яндекс браузер|brave|vivaldi|visual studio code|word|excel|powerpoint|блокнот|notepad\+*|obsidian|telegram|notion|sublime text|webstorm|intellij idea|pycharm)\b.*$/i;

const STOP = new Set(
  (
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня " +
    "еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам " +
    "the and for are but not you all any can had her was one our out has have this that with from they will " +
    "http https www com org net html txt file"
  ).split(/\s+/),
);

/** Заголовок окна → поисковая фраза ('' — искать нечего или нельзя). */
export function queryFromTitle(title: string): string {
  let t = String(title ?? "").trim();
  if (!t || SENSITIVE.test(t)) return "";
  t = t
    .replace(APP_TAIL, "")
    .replace(/\.[a-z0-9]{1,5}\s*$/i, "")
    .replace(/[*●•]\s*$/, "")
    .trim();
  if (GENERIC.has(t.toLowerCase())) return "";
  const tokens = tokenize(t).filter((w) => !STOP.has(w));
  return tokens.slice(0, 10).join(" ");
}

/** Ключевые слова текста: чаще встречаются и длиннее — важнее. */
export function keywords(text: string, n = 10): string[] {
  const freq = new Map<string, number>();
  for (const w of tokenize(String(text ?? "").slice(0, 8000))) {
    if (STOP.has(w) || /^\d+$/.test(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const score = (e: [string, number]): number => e[1] * (1 + e[0].length / 10);
  return [...freq.entries()]
    .sort((a, b) => score(b) - score(a) || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([w]) => w);
}

/** Итоговый запрос: выделенный текст важнее заголовка окна. */
export function buildQuery(p: { title?: string; text?: string }): string {
  const sel = String(p.text ?? "").trim();
  if (SENSITIVE.test(sel)) return "";
  if (sel.length >= 12) return sel.replace(/\s+/g, " ").slice(0, 300);
  return queryFromTitle(p.title ?? "");
}

export type GhostSource =
  | "note"
  | "lecture"
  | "budget"
  | "task"
  | "quick"
  | "bookmark"
  | "chat"
  | "canvas"
  | "rss"
  | "file"
  | "movie"
  | "book"
  | "m3e"
  | "archive";
export const GHOST_SOURCES: GhostSource[] = [
  "note",
  "task",
  "lecture",
  "quick",
  "bookmark",
  "chat",
  "canvas",
  "budget",
  "rss",
  "file",
  "movie",
  "book",
  "m3e",
  "archive",
];

export interface GhostHit {
  source: string;
  ref: string;
  title: string;
  snippet: string;
  score: number;
  at?: number;
}

export interface GhostGroup {
  source: GhostSource;
  items: GhostHit[];
}

/** Убирает «себя», слабые совпадения, дубликаты и группирует по источникам. */
export function groupHits(
  hits: GhostHit[],
  o: { exclude?: { source: string; ref: string }; perSource?: number; minScore?: number } = {},
): GhostGroup[] {
  const per = o.perSource ?? 3;
  const min = o.minScore ?? 0;
  const seen = new Set<string>();
  const by = new Map<GhostSource, GhostHit[]>();
  for (const h of hits) {
    if (!GHOST_SOURCES.includes(h.source as GhostSource)) continue;
    if (h.score < min) continue;
    if (o.exclude && o.exclude.source === h.source && o.exclude.ref === h.ref) continue;
    const key = `${h.source}\u0000${h.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = by.get(h.source as GhostSource) ?? [];
    if (list.length < per) list.push(h);
    by.set(h.source as GhostSource, list);
  }
  return GHOST_SOURCES.filter((s) => by.has(s)).map((s) => ({ source: s, items: by.get(s) ?? [] }));
}

// ---------------- активное окно (Windows) ----------------

export interface ActiveWindow {
  title: string;
  process: string;
}

/** Разбор вывода PowerShell (JSON в последней строке) — отдельно для тестов. */
export function parseActiveWindow(raw: string): ActiveWindow | null {
  try {
    const o = JSON.parse(String(raw).trim().split(/\r?\n/).pop() || "");
    if (o && typeof o.title === "string" && typeof o.process === "string")
      return { title: o.title, process: o.process };
  } catch {
    /* не JSON */
  }
  return null;
}

export const ACTIVE_WINDOW_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Name Win -Namespace Ghost -MemberDefinition '
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'
$h = [Ghost.Win]::GetForegroundWindow()
$procId = 0
[Ghost.Win]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
try { $p = Get-Process -Id $procId -ErrorAction Stop; $o = @{ title = [string]$p.MainWindowTitle; process = [string]$p.ProcessName } }
catch { $o = @{ title = ''; process = '' } }
$o | ConvertTo-Json -Compress
`;
