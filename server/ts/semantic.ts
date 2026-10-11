/**
 * Семантический индекс: заметки, закладки (и дальше — лекции, доски и т.д.) режутся на куски,
 * куски превращаются в векторы EmbeddingGemma (llama.cpp, см. llamacpp/embed.ts) и ищутся по косинусу.
 *
 * Хранилище — два файла в storage/semantic: meta.json (описания кусков) и vectors.bin
 * (Float32 подряд, DIM чисел на кусок, в порядке meta). Для десятков тысяч кусков перебора достаточно.
 * Куски пересчитываются только у того источника, чей текст изменился (хеш).
 */
import { fileDocs } from "./fileTextIndex";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import {
  DIM,
  embedConfig,
  embedModelSelected,
  embedModelFile,
  embedModels,
  embedRaw,
  embedRuntime,
  withPrefix,
} from "./llamacpp/embed";
import * as vault from "./myspace-vault";
import { tables } from "./db";
import { ftsCount, ftsHas, ftsPut, ftsRemove, ftsSearch } from "./ftsIndex";
import { rrf } from "./hybridRank";

const { DIRS } = config;
const DIR = path.join(DIRS.storage, "semantic");
const META = path.join(DIR, "meta.json");
const VEC = path.join(DIR, "vectors.bin");

export type SemSource =
  | "note"
  | "bookmark"
  | "lecture"
  | "chat"
  | "task"
  | "canvas"
  | "quick"
  | "budget"
  | "movie"
  | "book"
  | "m3e"
  | "archive"
  | "rss"
  | "file";

interface ChunkMeta {
  source: SemSource;
  /** Путь заметки или id закладки. */
  ref: string;
  title: string;
  /** Начало текста куска — для показа в результатах. */
  snippet: string;
  /** Метка внутри источника (лекция — миллисекунды от начала). */
  at?: number;
}
interface RefMeta {
  hash: string;
  title: string;
  /** Метка времени последнего пересчёта. */
  at: number;
}

interface Store {
  model: string;
  chunks: ChunkMeta[];
  vecs: Float32Array;
  refs: Record<string, RefMeta>;
}

let store: Store | null = null;
let saveTimer: NodeJS.Timeout | null = null;

const refKey = (source: SemSource, ref: string): string => `${source}\u0000${ref}`;

function load(): Store {
  if (store) return store;
  const empty: Store = { model: "", chunks: [], vecs: new Float32Array(0), refs: {} };
  try {
    const meta = JSON.parse(fs.readFileSync(META, "utf8")) as {
      model: string;
      dim: number;
      chunks: ChunkMeta[];
      refs: Record<string, RefMeta>;
    };
    const buf = fs.readFileSync(VEC);
    const vecs = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    if (meta.dim !== DIM || vecs.length !== meta.chunks.length * DIM) throw new Error("mismatch");
    store = { model: meta.model, chunks: meta.chunks, vecs, refs: meta.refs };
  } catch {
    store = empty;
  }
  return store;
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = store;
    if (!s) return;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(
        META,
        JSON.stringify({ model: s.model, dim: DIM, chunks: s.chunks, refs: s.refs }),
        "utf8",
      );
      fs.writeFileSync(VEC, Buffer.from(s.vecs.buffer, s.vecs.byteOffset, s.vecs.byteLength));
    } catch (e) {
      logger.warn("semantic.save_failed", { error: (e as Error).message });
    }
  }, 1500);
  saveTimer.unref?.();
}

process.once("exit", () => {
  if (!store || !saveTimer) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(
      META,
      JSON.stringify({ model: store.model, dim: DIM, chunks: store.chunks, refs: store.refs }),
    );
    fs.writeFileSync(
      VEC,
      Buffer.from(store.vecs.buffer, store.vecs.byteOffset, store.vecs.byteLength),
    );
  } catch {
    /* ignore */
  }
});

// ───────────────────────────── нарезка ─────────────────────────────

const MAX_CHARS = 1400;
/** У EmbeddingGemma «чужие» тексты сидят около 0.55–0.67, по теме — от 0.75: пороги под это. */
const SEARCH_MIN = 0.66;
const RELATED_MIN = 0.72;

/** Текст на куски по абзацам (до ~1400 символов); у каждого куска остаётся общий заголовок. */
export function chunkText(text: string): string[] {
  const clean = text
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[(?:task|canvas):[^\]]*\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]/g, " ");
  const paras = clean
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 1);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (p.length > MAX_CHARS) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < p.length; i += MAX_CHARS) out.push(p.slice(i, i + MAX_CHARS));
      continue;
    }
    if (cur && cur.length + p.length > MAX_CHARS) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.length >= 12);
}

const sha = (s: string): string => crypto.createHash("sha1").update(s).digest("hex");

// ───────────────────────────── запись в индекс ─────────────────────────────

function dropRef(s: Store, source: SemSource, ref: string): void {
  const keep: number[] = [];
  s.chunks.forEach((c, i) => {
    if (!(c.source === source && c.ref === ref)) keep.push(i);
  });
  if (keep.length === s.chunks.length) return;
  const vecs = new Float32Array(keep.length * DIM);
  keep.forEach((from, to) => vecs.set(s.vecs.subarray(from * DIM, (from + 1) * DIM), to * DIM));
  s.chunks = keep.map((i) => s.chunks[i]);
  s.vecs = vecs;
}

/** Переиндексировать один источник; false — не изменилось. */
export interface Part {
  text: string;
  at?: number;
}

export async function indexRef(
  source: SemSource,
  ref: string,
  title: string,
  text: string,
  pre?: Part[],
): Promise<boolean> {
  const s = load();
  const file = embedModelFile();
  if (!file) {
    // Без модели индексируем только лексически: поиск по словам работает сразу.
    lexicalIndex(source, ref, title, text, pre);
    return false;
  }
  if (s.model && s.model !== file) {
    s.chunks = [];
    s.vecs = new Float32Array(0);
    s.refs = {};
  }
  s.model = file;
  const key = refKey(source, ref);
  const full = `${title}\n${text}${pre ? pre.map((p) => p.text).join("") : ""}`;
  const hash = sha(full);
  if (s.refs[key]?.hash === hash) {
    // Индекс мог быть построен до появления полнотекстовой части — дозаполняем.
    if (!ftsHas(source, ref)) lexicalIndex(source, ref, title, text, pre);
    return false;
  }
  const parts: Part[] = pre ?? chunkText(text).map((t) => ({ text: t }));
  if (!parts.length && title.trim().length > 2) parts.push({ text: title.trim() });
  if (!parts.length) {
    dropRef(s, source, ref);
    delete s.refs[key];
    ftsRemove(source, ref);
    save();
    return true;
  }
  ftsPut(
    source,
    ref,
    title,
    parts.map((p) => p.text),
  );
  const vecs = await embedRaw(parts.map((p) => withPrefix(p.text, "doc", title)));
  dropRef(s, source, ref);
  const merged = new Float32Array(s.vecs.length + vecs.length * DIM);
  merged.set(s.vecs, 0);
  vecs.forEach((v, i) => merged.set(v, s.vecs.length + i * DIM));
  s.vecs = merged;
  parts.forEach((p) =>
    s.chunks.push({ source, ref, title, snippet: p.text.slice(0, 260), at: p.at }),
  );
  s.refs[key] = { hash, title, at: Date.now() };
  save();
  return true;
}

/** Только полнотекстовая часть индекса (без векторов). */
function lexicalIndex(
  source: SemSource,
  ref: string,
  title: string,
  text: string,
  pre?: Part[],
): void {
  const parts = (pre ?? chunkText(text).map((t) => ({ text: t }))).map((p) => p.text);
  if (!parts.length && title.trim().length > 2) parts.push(title.trim());
  if (parts.length) ftsPut(source, ref, title, parts);
  else ftsRemove(source, ref);
}

export function removeRef(source: SemSource, ref: string): void {
  const s = load();
  ftsRemove(source, ref);
  dropRef(s, source, ref);
  delete s.refs[refKey(source, ref)];
  save();
}

// ───────────────────────────── что индексируем ─────────────────────────────

interface Doc {
  source: SemSource;
  ref: string;
  title: string;
  text: string;
  parts?: Part[];
}

function noteDocs(): Doc[] {
  const out: Doc[] = [];
  const walk = (items: vault.VaultTreeItem[]): void => {
    for (const it of items) {
      if (it.type === "folder") walk(it.children ?? []);
      else if (it.type === "note") {
        const f = vault.readFile(it.path);
        if (f)
          out.push({
            source: "note",
            ref: it.path,
            title: f.name.replace(/\.\w+$/, ""),
            text: f.content,
          });
      }
    }
  };
  walk(vault.buildTree());
  return out;
}

/** Закладки читаем из файла напрямую: модуль bookmarks тянет за собой ИИ-провайдеры. */
interface BookmarkRow {
  id: string;
  title?: string;
  url?: string;
  notes?: string;
  tags?: string[];
  folder?: string;
  articleNotePath?: string | null;
}
export function readBookmarks(): BookmarkRow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(config.FILES.bookmarks, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function bookmarkDocs(): Doc[] {
  const out: Doc[] = [];
  for (const b of readBookmarks()) {
    let article = "";
    if (b.articleNotePath) article = vault.readFile(b.articleNotePath)?.content ?? "";
    const text = [b.notes, (b.tags ?? []).join(" "), b.folder, b.url, article]
      .filter(Boolean)
      .join("\n\n");
    out.push({ source: "bookmark", ref: b.id, title: b.title || b.url || b.id, text });
  }
  return out;
}

/** Лекции: куски расшифровки собираются в окна ~1000 символов с меткой времени начала. */
function lectureDocs(): Doc[] {
  const out: Doc[] = [];
  for (const l of tables.lectures.all()) {
    const chunks = tables.lecture_chunks
      .all()
      .filter((c) => c.lecture_id === l.id && c.text)
      .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
    const parts: Part[] = [];
    let cur = "";
    let at = 0;
    for (const c of chunks) {
      if (!cur) at = c.start_ms ?? 0;
      cur += `${cur ? " " : ""}${String(c.text).trim()}`;
      if (cur.length >= 1000) {
        parts.push({ text: cur, at });
        cur = "";
      }
    }
    if (cur.length >= 12) parts.push({ text: cur, at });
    const notes = String(l.notes ?? "");
    if (notes.length >= 12) for (const t of chunkText(notes)) parts.push({ text: t });
    out.push({
      source: "lecture",
      ref: String(l.id),
      title: l.title || "Лекция",
      text: "",
      parts,
    });
  }
  return out;
}

/** Чаты ИИ: реплики по порядку, окнами до ~1200 символов. */
function chatDocs(): Doc[] {
  const out: Doc[] = [];
  const byConv = new Map<number, string[]>();
  for (const m of tables.messages.all()) {
    if (!m.text) continue;
    const a = byConv.get(m.conversation_id) ?? [];
    a.push(`${m.role === "user" ? "Я" : "ИИ"}: ${String(m.text).replace(/\s+/g, " ").trim()}`);
    byConv.set(m.conversation_id, a);
  }
  for (const c of tables.conversations.all()) {
    const lines = byConv.get(c.id) ?? [];
    const parts: Part[] = [];
    let cur = "";
    for (const ln of lines) {
      const piece = ln.slice(0, 1200);
      if (cur && cur.length + piece.length > 1200) {
        parts.push({ text: cur });
        cur = "";
      }
      cur += `${cur ? "\n" : ""}${piece}`;
    }
    if (cur) parts.push({ text: cur });
    out.push({ source: "chat", ref: String(c.id), title: c.title || "Чат", text: "", parts });
  }
  return out;
}

interface TaskRow {
  id: string;
  title?: string;
  description?: string;
  tags?: string[];
  projectId?: string;
}
/** Задачи «Моего пространства» читаем из файла напрямую (роут тянет парсер и экспресс). */
export function readTasks(): TaskRow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIRS.vault, "tasks.json"), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function taskDocs(): Doc[] {
  return readTasks()
    .filter((t) => String(t.title ?? "").trim().length > 2)
    .map((t) => {
      const text = [t.title, t.description, (t.tags ?? []).join(" "), t.projectId]
        .filter(Boolean)
        .join(". ");
      return {
        source: "task" as const,
        ref: t.id,
        title: String(t.title).slice(0, 80),
        text,
        parts: [{ text }],
      };
    });
}

/** Проект и теги для новой задачи — по похожим уже существующим. */
export async function suggestTaskMeta(text: string): Promise<{ project: string; tags: string[] }> {
  const hits = (await search(text, { sources: ["task"], limit: 6 })).filter((h) => h.score >= 0.74);
  const byRef = new Map(readTasks().map((t) => [t.id, t]));
  const proj = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const h of hits) {
    const t = byRef.get(h.ref);
    if (!t) continue;
    if (t.projectId) proj.set(t.projectId, (proj.get(t.projectId) ?? 0) + h.score);
    for (const tg of t.tags ?? []) tags.set(tg, (tags.get(tg) ?? 0) + h.score);
  }
  const top = (m: Map<string, number>, n: number): string[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map((e) => e[0]);
  return { project: top(proj, 1)[0] ?? "", tags: top(tags, 3) };
}

/** Описания тайтлов из кэша TMDB (по id), чтобы искать фильм по сюжету. */
function overviews(): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of tables.media_meta_cache.rows) {
    const j = String(r.json ?? "");
    if (!j.includes('"overview"')) continue;
    try {
      const v = JSON.parse(j) as { id?: number; overview?: string };
      if (typeof v.id === "number" && v.overview) out.set(v.id, v.overview);
    } catch {
      /* битая запись кэша */
    }
  }
  return out;
}
function movieText(m: Record<string, unknown>, ov: Map<number, string>): string {
  return `${m.title}. ${m.year ?? ""}. ${m.genres ?? ""}. ${ov.get(Number(m.tmdb_id)) ?? ""}`.trim();
}
function movieDocs(): Doc[] {
  const ov = overviews();
  return tables.media_watchlist.all().map((m) => ({
    source: "movie" as const,
    ref: `${m.kind}:${m.tmdb_id}`,
    title: m.title || "",
    text: "",
    parts: [{ text: movieText(m, ov) }],
  }));
}

/** Избранное и закладки книг: название, автор, жанры, аннотация. */
interface BookRow {
  bid: number;
  title?: string;
  author?: string;
  genres?: string[];
  description?: string;
}
function bookText(b: BookRow): string {
  return `${b.title ?? ""}. ${b.author ?? ""}. ${(b.genres ?? []).join(", ")}. ${b.description ?? ""}`;
}
function myBooks(): BookRow[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("./flibusta") as { myBooks: (f?: string) => BookRow[] }).myBooks("all");
  } catch {
    return [];
  }
}
function bookDocs(): Doc[] {
  return myBooks().map((b) => ({
    source: "book" as const,
    ref: String(b.bid),
    title: b.title || String(b.bid),
    text: "",
    parts: [{ text: bookText(b) }],
  }));
}

/** Объекты доски с текстом (стикеры, подписи, имена рамок). */
export function canvasObjects(file: string): { id: string; text: string; type: string }[] {
  const r = vault.readHolst(file);
  const data = r?.data as { objs?: Record<string, unknown>[] } | null | undefined;
  const out: { id: string; text: string; type: string }[] = [];
  for (const o of data?.objs ?? []) {
    const text = String(o.text ?? o.name ?? o.label ?? "").trim();
    if (text.length >= 2) out.push({ id: String(o.id), text, type: String(o.type ?? "") });
  }
  return out;
}
/** Доски: каждый объект с текстом — своя запись «доска#id», чтобы находить и переходить к объекту. */
function canvasDocs(): Doc[] {
  const out: Doc[] = [];
  for (const h of vault.listHolsts()) {
    const file = h.path.replace(/\.holst$/, "");
    const title = h.title || file;
    for (const o of canvasObjects(file)) {
      out.push({
        source: "canvas",
        ref: `${file}#${o.id}`,
        title,
        text: "",
        parts: [{ text: o.text }],
      });
    }
  }
  return out;
}

function quickDocs(): Doc[] {
  const out: Doc[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(config.FILES.quickNotesIndex, "utf8"));
    for (const q of Array.isArray(raw) ? raw : []) {
      const text = String(q.structuredText || q.text || "").trim();
      if (text.length < 12) continue;
      out.push({
        source: "quick",
        ref: String(q.id),
        title: String(q.title || text.slice(0, 50)),
        text,
      });
    }
  } catch {
    /* нет быстрых заметок */
  }
  return out;
}

/** Бюджет: заголовок записи — категория, текст — комментарий (по соседям угадываем категорию). */
function budgetDocs(): Doc[] {
  const out: Doc[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(config.FILES.budgetTransactions, "utf8"));
    for (const t of Array.isArray(raw) ? raw : []) {
      const note = String(t.note ?? "").trim();
      if (note.length < 3 || !t.category || t.type !== "expense") continue;
      out.push({
        source: "budget",
        ref: String(t.id),
        title: String(t.category),
        text: note,
        parts: [{ text: note }],
      });
    }
  } catch {
    /* нет бюджета */
  }
  return out;
}

/** Макеты M3E: название, описание, имена экранов и подписи элементов. */
function m3eDocs(): Doc[] {
  const out: Doc[] = [];
  const dir = path.join(DIRS.storage, "m3e", "pages");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        title?: string;
        brief?: string;
        frames?: { name?: string }[];
        groups?: { items?: { label?: string; kind?: string }[] }[];
      };
      const labels = (d.groups ?? []).flatMap((g) =>
        (g.items ?? []).map((i) => i.label || i.kind || ""),
      );
      const text = [d.brief, ...(d.frames ?? []).map((x) => x.name), ...labels]
        .filter(Boolean)
        .join(". ");
      if (text.length < 8) continue;
      out.push({
        source: "m3e",
        ref: f.replace(/\.json$/, ""),
        title: d.title || d.brief?.slice(0, 50) || "Макет",
        text,
        parts: [{ text }],
      });
    } catch {
      /* битый файл макета */
    }
  }
  return out;
}

/** Веб-архивы: по адресу страницы (слова из пути и домен). */
/** Свежие статьи RSS: заголовок + описание (и перевод заголовка, если есть) — для поиска по смыслу. */
function rssDocs(): Doc[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rss = require("./rss") as typeof import("./rss");
    return rss.listItems({ limit: 500 }).map((i) => {
      const tr = Object.values(i.tr || {}).find((x) => x && typeof x === "object");
      const text = [i.title, tr ? tr.title : "", i.summary, tr ? tr.summary : ""]
        .filter(Boolean)
        .join(". ");
      return { source: "rss" as const, ref: i.id, title: i.title, text, parts: [{ text }] };
    });
  } catch {
    return [];
  }
}

function archiveDocs(): Doc[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIRS.sitebak, "archives.json"), "utf8"));
    return (Array.isArray(raw) ? raw : []).map(
      (a: { id: string; site?: string; name?: string }) => {
        let host = "";
        let words = String(a.site ?? "");
        try {
          const u = new URL(String(a.site));
          host = u.hostname;
          words = decodeURIComponent(u.pathname).replace(/[-_/.]+/g, " ");
        } catch {
          /* не URL */
        }
        const text = `${host} ${words}`.trim();
        return {
          source: "archive" as const,
          ref: String(a.id),
          title: host || String(a.name ?? a.id),
          text,
          parts: [{ text }],
        };
      },
    );
  } catch {
    return [];
  }
}

function fileSourceDocs(): Doc[] {
  return fileDocs().map((d) => ({ source: "file" as const, ref: d.ref, title: d.title, text: d.text }));
}

export interface JobState {
  running: boolean;
  done: number;
  total: number;
  error: string;
  startedAt: number;
}
let job: JobState = { running: false, done: 0, total: 0, error: "", startedAt: 0 };
export const jobState = (): JobState => job;

/** Полная синхронизация индекса с заметками и закладками (в фоне). */
export function syncAll(): JobState {
  if (job.running) return job;
  job = { running: true, done: 0, total: 0, error: "", startedAt: Date.now() };
  void (async () => {
    try {
      const docs = [
        ...noteDocs(),
        ...bookmarkDocs(),
        ...lectureDocs(),
        ...chatDocs(),
        ...taskDocs(),
        ...canvasDocs(),
        ...quickDocs(),
        ...budgetDocs(),
        ...movieDocs(),
        ...bookDocs(),
        ...m3eDocs(),
        ...archiveDocs(),
        ...rssDocs(),
        ...fileSourceDocs(),
      ];
      job.total = docs.length;
      const s = load();
      const live = new Set(docs.map((d) => refKey(d.source, d.ref)));
      for (const k of Object.keys(s.refs)) {
        if (!live.has(k)) {
          const [source, ref] = k.split("\u0000");
          removeRef(source as SemSource, ref);
        }
      }
      for (const d of docs) {
        await indexRef(d.source, d.ref, d.title, d.text, d.parts);
        job.done++;
      }
    } catch (e) {
      job.error = String((e as Error).message || e).slice(0, 300);
      logger.warn("semantic.sync_failed", { error: job.error });
    } finally {
      job.running = false;
    }
  })();
  return job;
}

// ───────────────────────────── изменения на лету ─────────────────────────────

const pending = new Map<string, NodeJS.Timeout>();
/** Заметку сохранили: переиндексируем через паузу, если индекс уже строили. */
export function noteChanged(notePath: string, removed = false): void {
  if (!Object.keys(load().refs).length && ftsCount() === 0) return;
  const prev = pending.get(notePath);
  if (prev) clearTimeout(prev);
  pending.set(
    notePath,
    setTimeout(() => {
      pending.delete(notePath);
      if (removed) return removeRef("note", notePath);
      const f = vault.readFile(notePath);
      if (!f) return removeRef("note", notePath);
      indexRef("note", notePath, f.name.replace(/\.\w+$/, ""), f.content).catch((e) =>
        logger.warn("semantic.note_failed", { error: (e as Error).message }),
      );
    }, 6000),
  );
}
vault.vaultEvents.on("write", (p: string) => noteChanged(p));
vault.vaultEvents.on("delete", (p: string) => noteChanged(p, true));

// ───────────────────────────── поиск ─────────────────────────────

export interface Hit {
  source: SemSource;
  ref: string;
  title: string;
  snippet: string;
  score: number;
  at?: number;
}

function dot(a: Float32Array, ao: number, b: Float32Array, bo: number): number {
  let n = 0;
  for (let i = 0; i < DIM; i++) n += a[ao + i] * b[bo + i];
  return n;
}

function rank(
  q: Float32Array,
  o: {
    sources?: SemSource[];
    exclude?: { source: SemSource; ref: string };
    limit?: number;
    min?: number;
  },
): Hit[] {
  const s = load();
  const best = new Map<string, Hit>();
  for (let i = 0; i < s.chunks.length; i++) {
    const c = s.chunks[i];
    if (o.sources && !o.sources.includes(c.source)) continue;
    if (o.exclude && c.source === o.exclude.source && c.ref === o.exclude.ref) continue;
    const sc = dot(q, 0, s.vecs, i * DIM);
    if (sc < (o.min ?? 0)) continue;
    const k = refKey(c.source, c.ref);
    const cur = best.get(k);
    if (!cur || sc > cur.score) {
      best.set(k, {
        source: c.source,
        ref: c.ref,
        title: c.title,
        snippet: c.snippet,
        score: sc,
        at: c.at,
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, o.limit ?? 10);
}

export async function search(
  query: string,
  o: { sources?: SemSource[]; limit?: number } = {},
): Promise<Hit[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = o.limit ?? 10;
  const lex = ftsSearch(q, { sources: o.sources, limit: limit * 2 });
  const haveVectors = !!embedModelFile() && load().chunks.length > 0;
  if (!haveVectors) return lex.slice(0, limit).map((h) => lexHit(h));
  let vec: Hit[] = [];
  try {
    const [v] = await embedRaw([withPrefix(q, "query")]);
    vec = rank(v, { ...o, limit: limit * 2, min: SEARCH_MIN });
  } catch (e) {
    // модель не поднялась — поиск по словам остаётся рабочим
    logger.warn("semantic.search_vector_failed", { error: (e as Error).message });
  }
  if (!lex.length) return vec.slice(0, limit);
  const lexHits = lex.map((h) => lexHit(h));
  const fused = rrf<Hit>([vec, lexHits]).map((f) => f.item);
  return fused.slice(0, limit);
}

/** Оценка для хитов, найденных только по словам: выше порога семантики, ниже уверенных совпадений. */
const LEX_ONLY_SCORE = 0.7;

function lexHit(h: { source: string; ref: string; title: string; snippet: string }): Hit {
  return {
    source: h.source as SemSource,
    ref: h.ref,
    title: h.title,
    snippet: h.snippet,
    score: LEX_ONLY_SCORE,
  };
}

/** Средний вектор источника (для «похожих» и дублей). */
function refVector(source: SemSource, ref: string): Float32Array | null {
  const s = load();
  const acc = new Float32Array(DIM);
  let n = 0;
  s.chunks.forEach((c, i) => {
    if (c.source !== source || c.ref !== ref) return;
    for (let d = 0; d < DIM; d++) acc[d] += s.vecs[i * DIM + d];
    n++;
  });
  if (!n) return null;
  let norm = 0;
  for (let d = 0; d < DIM; d++) norm += acc[d] * acc[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < DIM; d++) acc[d] /= norm;
  return acc;
}

export function related(
  source: SemSource,
  ref: string,
  o: { sources?: SemSource[]; limit?: number } = {},
): Hit[] {
  const v = embedModelFile() ? refVector(source, ref) : null;
  if (!v) return [];
  return rank(v, { ...o, exclude: { source, ref }, min: RELATED_MIN });
}

export interface DupPair {
  a: { ref: string; title: string };
  b: { ref: string; title: string };
  score: number;
}

/** Пары почти одинаковых источников одного типа (косинус выше порога). */
export function duplicates(source: SemSource, threshold = 0.93, limit = 50): DupPair[] {
  if (!embedModelFile()) return [];
  const s = load();
  const refs = Object.keys(s.refs)
    .filter((k) => k.startsWith(`${source}\u0000`))
    .map((k) => k.split("\u0000")[1]);
  const vs = refs.map((r) => refVector(source, r));
  const out: DupPair[] = [];
  for (let i = 0; i < refs.length; i++) {
    const a = vs[i];
    if (!a) continue;
    for (let j = i + 1; j < refs.length; j++) {
      const b = vs[j];
      if (!b) continue;
      const sc = dot(a, 0, b, 0);
      if (sc >= threshold) {
        out.push({
          a: { ref: refs[i], title: s.refs[refKey(source, refs[i])].title },
          b: { ref: refs[j], title: s.refs[refKey(source, refs[j])].title },
          score: sc,
        });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Кластеры источников: жадная группировка по близости к «центру» кластера. */
export function clusters(
  source: SemSource,
  threshold = 0.62,
  minSize = 2,
): { refs: { ref: string; title: string }[] }[] {
  if (!embedModelFile()) return [];
  const s = load();
  const refs = Object.keys(s.refs)
    .filter((k) => k.startsWith(`${source}\u0000`))
    .map((k) => k.split("\u0000")[1]);
  const groups: { center: Float32Array; members: string[] }[] = [];
  for (const r of refs) {
    const v = refVector(source, r);
    if (!v) continue;
    let bestG: (typeof groups)[number] | null = null;
    let bestS = threshold;
    for (const g of groups) {
      const sc = dot(v, 0, g.center, 0);
      if (sc > bestS) {
        bestS = sc;
        bestG = g;
      }
    }
    if (bestG) {
      bestG.members.push(r);
      for (let d = 0; d < DIM; d++) bestG.center[d] += v[d] / bestG.members.length;
      let n = 0;
      for (let d = 0; d < DIM; d++) n += bestG.center[d] ** 2;
      n = Math.sqrt(n) || 1;
      for (let d = 0; d < DIM; d++) bestG.center[d] /= n;
    } else groups.push({ center: Float32Array.from(v), members: [r] });
  }
  return groups
    .filter((g) => g.members.length >= minSize)
    .map((g) => ({
      refs: g.members.map((r) => ({ ref: r, title: s.refs[refKey(source, r)]?.title ?? r })),
    }))
    .sort((a, b) => b.refs.length - a.refs.length);
}

export interface Status {
  /** Включён ли умный поиск (выключатель в шапке). */
  enabled: boolean;
  device: "cpu" | "gpu" | "auto";
  /** Выбранная/лучшая установленная модель (даже если поиск выключен). */
  model: string | null;
  /** Установленные модели эмбеддингов. */
  models: string[];
  /** Что сейчас загружено в память. */
  runtime: { file: string; gpu: boolean; build: string } | null;
  indexed: Record<string, number>;
  chunks: number;
  job: JobState;
}

export function status(): Status {
  const s = load();
  const n: Record<string, number> = {};
  for (const k of Object.keys(s.refs)) {
    const src = k.split("\u0000")[0];
    n[src] = (n[src] ?? 0) + 1;
  }
  return {
    enabled: embedConfig().enabled,
    device: embedConfig().device,
    model: embedModelSelected(),
    models: embedModels(),
    runtime: embedRuntime(),
    indexed: n,
    chunks: s.chunks.length,
    job,
  };
}

/** Тексты без сохранения: группы по близости (автораскладка стикеров). */
export async function groupTexts(texts: string[], threshold = 0.7): Promise<number[][]> {
  if (!texts.length) return [];
  const vs = await embedRaw(texts.map((t) => withPrefix(t, "similar")));
  const groups: { center: Float32Array; idx: number[] }[] = [];
  vs.forEach((v, i) => {
    let best: (typeof groups)[number] | null = null;
    let bs = threshold;
    for (const g of groups) {
      const sc = dot(v, 0, g.center, 0);
      if (sc > bs) {
        bs = sc;
        best = g;
      }
    }
    if (best) {
      best.idx.push(i);
      for (let d = 0; d < DIM; d++) best.center[d] += v[d] / best.idx.length;
      let n = 0;
      for (let d = 0; d < DIM; d++) n += best.center[d] ** 2;
      n = Math.sqrt(n) || 1;
      for (let d = 0; d < DIM; d++) best.center[d] /= n;
    } else groups.push({ center: Float32Array.from(v), idx: [i] });
  });
  return groups.map((g) => g.idx);
}

/** Категория траты по похожим прошлым записям (голосование, вес — близость). */
export async function classifyExpense(
  note: string,
): Promise<{ category: string; score: number }[]> {
  const hits = await search(note, { sources: ["budget"], limit: 8 });
  const votes = new Map<string, number>();
  for (const h of hits) votes.set(h.title, (votes.get(h.title) ?? 0) + h.score);
  return [...votes.entries()]
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);
}

export const ALL_SOURCES: SemSource[] = [
  "note",
  "bookmark",
  "lecture",
  "chat",
  "task",
  "canvas",
  "quick",
  "budget",
  "movie",
  "book",
  "m3e",
  "archive",
  "rss",
  "file",
];

/** Раз в 10 минут (если индекс уже строили) подтягиваем лекции, чаты, задачи, доски и т.п. */
setInterval(() => {
  if (embedModelFile() && Object.keys(load().refs).length) syncAll();
}, 600000).unref();

const rankCache = new Map<string, Float32Array>();
/** Близость запроса к произвольным текстам (поиск по настройкам и т.п.); векторы текстов кэшируются в памяти. */
export async function rankTexts(query: string, texts: string[]): Promise<number[]> {
  const need = texts.filter((t) => !rankCache.has(t));
  if (need.length) {
    const vs = await embedRaw(need.map((t) => withPrefix(t, "doc")));
    need.forEach((t, i) => rankCache.set(t, vs[i]));
  }
  const [q] = await embedRaw([withPrefix(query, "query")]);
  return texts.map((t) => dot(q, 0, rankCache.get(t) as Float32Array, 0));
}

/** Долгая память ИИ-чата: похожие места из прошлых разговоров как системная подсказка. */
export async function memoryFor(convId: number, text: string): Promise<string> {
  try {
    if (!embedModelFile()) return "";
    const hits = (await search(text, { sources: ["chat"], limit: 6 }))
      .filter((h) => h.ref !== String(convId) && h.score >= 0.74)
      .slice(0, 3);
    if (!hits.length) return "";
    return (
      "Из прошлых разговоров с пользователем (используй, только если относится к вопросу):\n" +
      hits.map((h) => `— «${h.title}»: ${h.snippet.slice(0, 220)}`).join("\n")
    );
  } catch {
    return "";
  }
}

/** Фильмы из «планов», больше всего похожие на понравившиеся (просмотрено или оценка 8+). */
export function recommendMovies(): { ref: string; title: string; score: number }[] {
  if (!embedModelFile()) return [];
  const ratings = new Map(
    tables.media_ratings.all().map((r) => [`${r.kind}:${r.tmdb_id}`, Number(r.rating) || 0]),
  );
  const items = tables.media_watchlist.all();
  const liked = items
    .filter((m) => {
      const r = ratings.get(`${m.kind}:${m.tmdb_id}`) ?? 0;
      return r >= 8 || (m.status === "watched" && r === 0);
    })
    .map((m) => refVector("movie", `${m.kind}:${m.tmdb_id}`))
    .filter((v): v is Float32Array => !!v);
  if (!liked.length) return [];
  return items
    .filter((m) => m.status === "plan")
    .map((m) => {
      const ref = `${m.kind}:${m.tmdb_id}`;
      const v = refVector("movie", ref);
      const score = v ? Math.max(...liked.map((l) => dot(v, 0, l, 0))) : 0;
      return { ref, title: String(m.title), score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Насколько каждая книга из списка похожа на избранное/закладки пользователя. */
export async function booksSimilarity(
  books: BookRow[],
): Promise<{ bid: number; score: number; like: string }[]> {
  const mine = myBooks();
  if (!mine.length || !books.length) return [];
  const texts = [...mine.map(bookText), ...books.map(bookText)];
  const need = texts.filter((t) => !rankCache.has(t));
  if (need.length) {
    const vs = await embedRaw(need.map((t) => withPrefix(t, "doc")));
    need.forEach((t, i) => rankCache.set(t, vs[i]));
  }
  const mv = mine.map((b) => rankCache.get(bookText(b)) as Float32Array);
  return books.map((b) => {
    const v = rankCache.get(bookText(b)) as Float32Array;
    let best = 0;
    let like = "";
    mv.forEach((m, i) => {
      if (mine[i].bid === b.bid) return;
      const sc = dot(v, 0, m, 0);
      if (sc > best) {
        best = sc;
        like = mine[i].title ?? "";
      }
    });
    return { bid: b.bid, score: best, like };
  });
}
