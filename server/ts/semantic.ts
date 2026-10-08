/**
 * Семантический индекс: заметки, закладки (и дальше — лекции, доски и т.д.) режутся на куски,
 * куски превращаются в векторы EmbeddingGemma (llama.cpp, см. llamacpp/embed.ts) и ищутся по косинусу.
 *
 * Хранилище — два файла в storage/semantic: meta.json (описания кусков) и vectors.bin
 * (Float32 подряд, DIM чисел на кусок, в порядке meta). Для десятков тысяч кусков перебора достаточно.
 * Куски пересчитываются только у того источника, чей текст изменился (хеш).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import { DIM, embedModelFile, embedRaw, withPrefix } from "./llamacpp/embed";
import * as vault from "./myspace-vault";

const { DIRS } = config;
const DIR = path.join(DIRS.storage, "semantic");
const META = path.join(DIR, "meta.json");
const VEC = path.join(DIR, "vectors.bin");

export type SemSource = "note" | "bookmark";

interface ChunkMeta {
  source: SemSource;
  /** Путь заметки или id закладки. */
  ref: string;
  title: string;
  /** Начало текста куска — для показа в результатах. */
  snippet: string;
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
export async function indexRef(
  source: SemSource,
  ref: string,
  title: string,
  text: string,
): Promise<boolean> {
  const s = load();
  const file = embedModelFile();
  if (!file) throw new Error("embed_model_missing");
  if (s.model && s.model !== file) {
    s.chunks = [];
    s.vecs = new Float32Array(0);
    s.refs = {};
  }
  s.model = file;
  const key = refKey(source, ref);
  const full = `${title}\n${text}`;
  const hash = sha(full);
  if (s.refs[key]?.hash === hash) return false;
  const parts = chunkText(text);
  if (!parts.length && title.trim().length > 2) parts.push(title.trim());
  if (!parts.length) {
    dropRef(s, source, ref);
    delete s.refs[key];
    save();
    return true;
  }
  const vecs = await embedRaw(parts.map((p) => withPrefix(p, "doc", title)));
  dropRef(s, source, ref);
  const merged = new Float32Array(s.vecs.length + vecs.length * DIM);
  merged.set(s.vecs, 0);
  vecs.forEach((v, i) => merged.set(v, s.vecs.length + i * DIM));
  s.vecs = merged;
  parts.forEach((p) => s.chunks.push({ source, ref, title, snippet: p.slice(0, 260) }));
  s.refs[key] = { hash, title, at: Date.now() };
  save();
  return true;
}

export function removeRef(source: SemSource, ref: string): void {
  const s = load();
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
  if (job.running || !embedModelFile()) return job;
  job = { running: true, done: 0, total: 0, error: "", startedAt: Date.now() };
  void (async () => {
    try {
      const docs = [...noteDocs(), ...bookmarkDocs()];
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
        await indexRef(d.source, d.ref, d.title, d.text);
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
  if (!embedModelFile() || !Object.keys(load().refs).length) return;
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
      best.set(k, { source: c.source, ref: c.ref, title: c.title, snippet: c.snippet, score: sc });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, o.limit ?? 10);
}

export async function search(
  query: string,
  o: { sources?: SemSource[]; limit?: number } = {},
): Promise<Hit[]> {
  const q = query.trim();
  if (!q || !load().chunks.length) return [];
  const [v] = await embedRaw([withPrefix(q, "query")]);
  return rank(v, { ...o, min: SEARCH_MIN });
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
  const v = refVector(source, ref);
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
  model: string | null;
  indexed: { note: number; bookmark: number };
  chunks: number;
  job: JobState;
}

export function status(): Status {
  const s = load();
  const n = { note: 0, bookmark: 0 };
  for (const k of Object.keys(s.refs)) {
    if (k.startsWith("note\u0000")) n.note++;
    else if (k.startsWith("bookmark\u0000")) n.bookmark++;
  }
  return { model: embedModelFile(), indexed: n, chunks: s.chunks.length, job };
}
