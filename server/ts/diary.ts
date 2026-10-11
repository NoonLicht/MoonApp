/**
 * Дневник: по одной записи-Markdown на день (storage/diary/YYYY-MM-DD.md),
 * шаблон записи (_template.md) и сводка недели по заметкам, задачам и лекциям.
 *
 * Записи — обычные .md-файлы: их можно открыть и править чем угодно, а бэкап
 * папки — это бэкап дневника. Имя файла строится ТОЛЬКО из проверенной даты,
 * поэтому выйти за пределы каталога через параметр запроса нельзя.
 *
 * Сводка недели собирается без ИИ (digest — счётчики и списки), а если провайдер
 * настроен, модель превращает те же данные в связный итог. Без ключа дневник
 * остаётся полностью рабочим.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";

import type {
  DiaryEntry,
  DiaryListItem,
  DigestLabels,
  SavedWeekSummary,
  WeekSummaryResult,
} from "./contracts/diary";

export type { DiaryEntry, DiaryListItem, DigestLabels, SavedWeekSummary, WeekSummaryResult };

const { DIRS } = config;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEMPLATE_FILE = "_template.md";

/** Проверка даты: формат И существование в календаре (2026-02-31 не пройдёт). */
export function isValidDate(date: unknown): date is string {
  if (typeof date !== "string" || !DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

function fileOf(date: string): string {
  if (!isValidDate(date)) throw new Error("invalid_date");
  return path.join(DIRS.diary, `${date}.md`);
}

export function readEntry(date: string): DiaryEntry {
  const f = fileOf(date);
  try {
    return { date, content: fs.readFileSync(f, "utf8"), exists: true };
  } catch {
    return { date, content: "", exists: false };
  }
}

/** Пустой текст удаляет файл: «пустых дней» в календаре быть не должно. */
export function writeEntry(date: string, content: string): DiaryEntry {
  const f = fileOf(date);
  const text = String(content ?? "");
  if (!text.trim()) {
    if (fs.existsSync(f)) fs.rmSync(f);
    return { date, content: "", exists: false };
  }
  fs.writeFileSync(f, text, "utf8");
  return { date, content: text, exists: true };
}

export function deleteEntry(date: string): boolean {
  const f = fileOf(date);
  if (!fs.existsSync(f)) return false;
  fs.rmSync(f);
  return true;
}

const countWords = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) || []).length;

function previewOf(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    const clean = line.replace(/^[#>\-*\s\d.[\]x]+/i, "").trim();
    if (clean) return clean.slice(0, 120);
  }
  return "";
}

/** Записи в диапазоне дат [from, to] (включительно), новые первыми. */
export function listEntries(from?: string, to?: string): DiaryListItem[] {
  const lo = isValidDate(from) ? from : "0000-00-00";
  const hi = isValidDate(to) ? to : "9999-99-99";
  const out: DiaryListItem[] = [];
  for (const name of fs.readdirSync(DIRS.diary)) {
    const date = name.slice(0, -3);
    if (!name.endsWith(".md") || !isValidDate(date) || date < lo || date > hi) continue;
    const text = fs.readFileSync(path.join(DIRS.diary, name), "utf8");
    out.push({ date, words: countWords(text), preview: previewOf(text) });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Серия подряд идущих дней с записью, заканчивающаяся сегодня или вчера. */
export function streak(dates: string[], today: string): number {
  const set = new Set(dates);
  const d = parseYmd(today);
  if (!set.has(ymd(d))) d.setDate(d.getDate() - 1); // сегодня ещё можно написать
  let n = 0;
  while (set.has(ymd(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function getTemplate(): string | null {
  try {
    return fs.readFileSync(path.join(DIRS.diary, TEMPLATE_FILE), "utf8");
  } catch {
    return null;
  }
}

/** Пустой шаблон сбрасывается к встроенному (его подставляет клиент). */
export function setTemplate(text: string): string | null {
  const f = path.join(DIRS.diary, TEMPLATE_FILE);
  if (!String(text ?? "").trim()) {
    if (fs.existsSync(f)) fs.rmSync(f);
    return null;
  }
  fs.writeFileSync(f, String(text), "utf8");
  return String(text);
}

/* ------------------------------ сводка недели ------------------------------ */

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Понедельник–воскресенье недели, в которую попадает дата. */
export function weekRange(date: string): { start: string; end: string; days: string[] } {
  if (!isValidDate(date)) throw new Error("invalid_date");
  const d = parseYmd(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(ymd(d));
    d.setDate(d.getDate() + 1);
  }
  return { start: days[0], end: days[6], days };
}

/* ---------------------- сохранённый итог недели ---------------------- */

function summaryFile(date: string): string {
  return path.join(DIRS.diary, `_week_${weekRange(date).start}.json`);
}

/** Итог недели, в которую попадает дата (exists=false, если ещё не сохранён). */
export function getSavedSummary(date: string): SavedWeekSummary {
  const { start, end } = weekRange(date);
  try {
    const j = JSON.parse(fs.readFileSync(summaryFile(date), "utf8")) as Partial<SavedWeekSummary>;
    if (typeof j.markdown === "string" && j.markdown.trim()) {
      return { ...j, exists: true, start, end, markdown: j.markdown, ai: !!j.ai };
    }
  } catch {
    /* нет файла или он повреждён — считаем, что итога нет */
  }
  return { exists: false, start, end, markdown: "", ai: false };
}

export function saveSummary(
  date: string,
  markdown: string,
  meta: { ai?: boolean; provider?: string; model?: string; edited?: boolean } = {},
): SavedWeekSummary {
  const { start, end } = weekRange(date);
  const text = markdown.replace(/\r\n/g, "\n");
  if (!text.trim()) {
    deleteSummary(date);
    return { exists: false, start, end, markdown: "", ai: false };
  }
  fs.mkdirSync(DIRS.diary, { recursive: true });
  const prev = getSavedSummary(date);
  const rec = {
    markdown: text,
    ai: meta.ai ?? prev.ai,
    provider: meta.provider ?? prev.provider,
    model: meta.model ?? prev.model,
    edited: meta.edited ?? false,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(summaryFile(date), JSON.stringify(rec, null, 2), "utf8");
  return { exists: true, start, end, ...rec };
}

export function deleteSummary(date: string): boolean {
  try {
    fs.unlinkSync(summaryFile(date));
    return true;
  } catch {
    return false;
  }
}

/* ---------------- итог, прикреплённый к записи дня ----------------
 * «Добавить в запись этого дня» не дописывает итог в текст записи: шаблонная запись
 * остаётся как есть (её правят кнопкой «Изменить»), а день открывается готовым итогом. */

function daySummaryFile(date: string): string {
  if (!isValidDate(date)) throw new Error("invalid_date");
  return path.join(DIRS.diary, `_day_${date}.json`);
}

export function getDaySummary(date: string): SavedWeekSummary {
  const file = daySummaryFile(date);
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SavedWeekSummary>;
    if (typeof j.markdown === "string" && j.markdown.trim()) {
      return { ...j, exists: true, start: date, end: date, markdown: j.markdown, ai: !!j.ai };
    }
  } catch {
    /* нет файла или он повреждён */
  }
  return { exists: false, start: date, end: date, markdown: "", ai: false };
}

export function saveDaySummary(
  date: string,
  markdown: string,
  meta: { ai?: boolean; provider?: string; model?: string } = {},
): SavedWeekSummary {
  const text = markdown.replace(/\r\n/g, "\n");
  if (!text.trim()) {
    deleteDaySummary(date);
    return { exists: false, start: date, end: date, markdown: "", ai: false };
  }
  fs.mkdirSync(DIRS.diary, { recursive: true });
  const rec = { markdown: text, ai: !!meta.ai, provider: meta.provider, model: meta.model, updatedAt: new Date().toISOString() };
  fs.writeFileSync(daySummaryFile(date), JSON.stringify(rec, null, 2), "utf8");
  return { exists: true, start: date, end: date, ...rec };
}

export function deleteDaySummary(date: string): boolean {
  try {
    fs.unlinkSync(daySummaryFile(date));
    return true;
  } catch {
    return false;
  }
}

export interface WeekSources {
  /** Записи дневника недели. */
  entries: { date: string; content: string }[];
  tasks: { title: string; status?: string; created_at?: string; updated_at?: string }[];
  notes: { title: string; updated_at?: string }[];
  lectures: { title: string; started_at?: string }[];
}

export interface WeekData {
  start: string;
  end: string;
  entries: { date: string; content: string }[];
  tasksDone: string[];
  tasksCreated: string[];
  notesTouched: string[];
  lectures: string[];
}

const inWeek = (iso: string | undefined, start: string, end: string): boolean => {
  const day = String(iso || "").slice(0, 10);
  return !!day && day >= start && day <= end;
};

/** Отбирает из источников только то, что относится к неделе. Чистая функция. */
export function collectWeek(date: string, src: WeekSources): WeekData {
  const { start, end } = weekRange(date);
  return {
    start,
    end,
    entries: src.entries.filter((e) => e.date >= start && e.date <= end && e.content.trim()),
    tasksDone: src.tasks
      .filter((t) => (t.status === "completed" || t.status === "done") && inWeek(t.updated_at, start, end))
      .map((t) => t.title),
    tasksCreated: src.tasks.filter((t) => inWeek(t.created_at, start, end)).map((t) => t.title),
    notesTouched: src.notes.filter((n) => inWeek(n.updated_at, start, end)).map((n) => n.title),
    lectures: src.lectures.filter((l) => inWeek(l.started_at, start, end)).map((l) => l.title),
  };
}

const bullets = (items: string[], max = 12): string =>
  items.slice(0, max).map((x) => `- ${x}`).join("\n") +
  (items.length > max ? `\n- … +${items.length - max}` : "");

/** Сводка без ИИ: счётчики и списки. Запасной вариант, когда провайдер не настроен. */
export function buildDigest(w: WeekData, l: DigestLabels): string {
  const parts = [`## ${l.title} ${w.start} — ${w.end}`];
  const section = (label: string, items: string[]) => {
    if (items.length) parts.push(`**${label}: ${items.length}**\n${bullets(items)}`);
  };
  section(l.entries, w.entries.map((e) => `${e.date}: ${previewOf(e.content)}`));
  section(l.tasksDone, w.tasksDone);
  section(l.tasksCreated, w.tasksCreated);
  section(l.notes, w.notesTouched);
  section(l.lectures, w.lectures);
  if (parts.length === 1) parts.push(l.nothing);
  return parts.join("\n\n");
}

/** Текст запроса к модели: данные недели + что именно нужно получить. */
export function buildWeekPrompt(w: WeekData, language: string): string {
  const diary = w.entries.map((e) => `### ${e.date}\n${e.content.trim().slice(0, 3000)}`).join("\n\n");
  return [
    `Неделя ${w.start} — ${w.end}. Ответь на языке: ${language}.`,
    "Составь итог недели для личного дневника: 1) главное за неделю (3–5 пунктов), " +
      "2) что получилось, 3) что не получилось или осталось, 4) настроение и энергия " +
      "(если видно из записей), 5) три предложения на следующую неделю. " +
      "Опирайся только на данные ниже, ничего не выдумывай, пиши от первого лица, коротко.",
    diary ? `ЗАПИСИ ДНЕВНИКА:\n${diary}` : "Записей дневника за эту неделю нет.",
    w.tasksDone.length ? `ВЫПОЛНЕННЫЕ ЗАДАЧИ:\n${bullets(w.tasksDone, 30)}` : "",
    w.tasksCreated.length ? `НОВЫЕ ЗАДАЧИ:\n${bullets(w.tasksCreated, 30)}` : "",
    w.notesTouched.length ? `ЗАМЕТКИ, КОТОРЫЕ ПРАВИЛ:\n${bullets(w.notesTouched, 30)}` : "",
    w.lectures.length ? `ЛЕКЦИИ:\n${bullets(w.lectures, 30)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Читает реальные источники приложения (задачи, заметки, лекции, дневник). */
function loadSources(date: string): WeekSources {
  const { start, end } = weekRange(date);
   
  const db = require("./db") as typeof import("./db");
  const notes = db.stmts.noteAll.all() as { title: string; updated_at?: string }[];
  const lectures = db.stmts.lectureAll.all() as unknown as { title: string; started_at?: string }[];
   
  let tasks: WeekSources["tasks"] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIRS.vault, "tasks.json"), "utf8"));
    if (Array.isArray(raw)) tasks = raw;
  } catch {
    /* задач ещё нет */
  }
  const entries = listEntries(start, end).map((i) => readEntry(i.date));
  return { entries, tasks, notes, lectures };
}

export function weekData(date: string): WeekData {
  return collectWeek(date, loadSources(date));
}

const SYSTEM_PROMPT =
  "Ты помогаешь вести личный дневник. Пиши по-человечески, кратко, в Markdown, без вступлений.";

export async function weekSummary(
  date: string,
  language: string,
  labels: DigestLabels,
  appPage: unknown = "diary",
): Promise<WeekSummaryResult> {
  const w = weekData(date);
  const digest = buildDigest(w, labels);
  const hasData = w.entries.length || w.tasksDone.length || w.notesTouched.length || w.lectures.length;
  if (!hasData) return { start: w.start, end: w.end, markdown: digest, ai: false, aiError: "no_data" };
  try {
     
    const { askAi } = require("./notesAi") as typeof import("./notesAi");
    const r = await askAi(buildWeekPrompt(w, language), SYSTEM_PROMPT, appPage, 1500);
    if (!r.text) throw new Error("empty_answer");
    logger.info("diary.weekSummary", { start: w.start, provider: r.provider, chars: r.text.length });
    return {
      start: w.start,
      end: w.end,
      markdown: `## ${labels.title} ${w.start} — ${w.end}\n\n${r.text}`,
      ai: true,
      provider: r.provider,
      model: r.model,
    };
  } catch (e) {
    const msg = (e as Error).message || "error";
    logger.warn("diary.weekSummary.ai_failed", { error: msg });
    return {
      start: w.start,
      end: w.end,
      markdown: digest,
      ai: false,
      aiError: msg.split(":")[0],
    };
  }
}
