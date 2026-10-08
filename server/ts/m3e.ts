/**
 * Хранилище «M3E Canvas» (Моё пространство → M3E): набор страниц-проектов.
 *
 *   storage/m3e/index.json          — порядок, активная страница, метаданные
 *   storage/m3e/pages/<id>.json     — документ страницы (Doc редактора)
 *   storage/m3e/trash/<id>.json     — удалённые страницы (можно вернуть)
 *
 * Документ сервер не разбирает: ему нужны лишь название и число экранов для списка.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "./config";

export interface PageMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** сколько экранов на холсте */
  screens: number;
  /** сколько элементов на холсте */
  parts: number;
  /** закреплена вверху списка */
  pinned?: boolean;
  /** произвольная пометка цвета вкладки (hex) */
  color?: string;
}

export interface TrashMeta extends PageMeta {
  deletedAt: number;
}

interface Index {
  version: 1;
  activeId: string | null;
  order: string[];
  pages: Record<string, PageMeta>;
  trash: Record<string, TrashMeta>;
}

const MAX_DOC = 40 * 1024 * 1024;
const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const ID_RE = /^[a-z0-9]{6,32}$/;

const root = (): string => path.join(config.DIRS.storage, "m3e");
const pagesDir = (): string => path.join(root(), "pages");
const trashDir = (): string => path.join(root(), "trash");
const indexFile = (): string => path.join(root(), "index.json");

export const isId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);
const newId = (): string => crypto.randomBytes(6).toString("hex");

function ensure(): void {
  fs.mkdirSync(pagesDir(), { recursive: true });
  fs.mkdirSync(trashDir(), { recursive: true });
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function load(): Index {
  ensure();
  let idx: Index = { version: 1, activeId: null, order: [], pages: {}, trash: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), "utf8")) as Partial<Index>;
    idx = {
      version: 1,
      activeId: typeof raw.activeId === "string" ? raw.activeId : null,
      order: Array.isArray(raw.order) ? raw.order.filter(isId) : [],
      pages: raw.pages && typeof raw.pages === "object" ? raw.pages : {},
      trash: raw.trash && typeof raw.trash === "object" ? raw.trash : {},
    };
  } catch {
    /* первого запуска ещё не было или индекс повреждён: соберём из файлов */
  }
  // Файлы без записи в индексе (например, индекс потерян) подхватываем, записи без файла выбрасываем.
  for (const f of fs.readdirSync(pagesDir())) {
    const id = f.replace(/\.json$/, "");
    if (!f.endsWith(".json") || !isId(id) || idx.pages[id]) continue;
    const st = fs.statSync(path.join(pagesDir(), f));
    idx.pages[id] = {
      id,
      title: "",
      createdAt: st.birthtimeMs || st.mtimeMs,
      updatedAt: st.mtimeMs,
      screens: 0,
      parts: 0,
    };
    idx.order.push(id);
  }
  idx.order = idx.order.filter((id, i, a) => idx.pages[id] && a.indexOf(id) === i);
  for (const id of Object.keys(idx.pages)) {
    if (!fs.existsSync(path.join(pagesDir(), `${id}.json`))) delete idx.pages[id];
    else if (!idx.order.includes(id)) idx.order.push(id);
  }
  idx.order = idx.order.filter((id) => idx.pages[id]);
  const now = Date.now();
  for (const [id, m] of Object.entries(idx.trash)) {
    if (now - m.deletedAt > TRASH_KEEP_MS || !fs.existsSync(path.join(trashDir(), `${id}.json`))) {
      delete idx.trash[id];
      fs.rmSync(path.join(trashDir(), `${id}.json`), { force: true });
    }
  }
  if (!idx.activeId || !idx.pages[idx.activeId]) idx.activeId = idx.order[0] ?? null;
  return idx;
}

function save(idx: Index): void {
  ensure();
  writeAtomic(indexFile(), JSON.stringify(idx));
}

/** Название, число экранов и элементов из текста документа (без разбора всего Doc). */
export function describeDoc(text: string): { title: string; screens: number; parts: number } {
  try {
    const d = JSON.parse(text) as { title?: unknown; frames?: unknown; groups?: unknown };
    const groups = Array.isArray(d.groups) ? (d.groups as { items?: unknown }[]) : [];
    return {
      title: typeof d.title === "string" ? d.title.trim().slice(0, 120) : "",
      screens: Array.isArray(d.frames) ? d.frames.length : 0,
      parts: groups.reduce((n, g) => n + (Array.isArray(g?.items) ? g.items.length : 0), 0),
    };
  } catch {
    return { title: "", screens: 0, parts: 0 };
  }
}

export interface Workbook {
  activeId: string | null;
  pages: PageMeta[];
  trash: TrashMeta[];
}

const view = (idx: Index): Workbook => ({
  activeId: idx.activeId,
  pages: idx.order.map((id) => idx.pages[id]),
  trash: Object.values(idx.trash).sort((a, b) => b.deletedAt - a.deletedAt),
});

export function list(): Workbook {
  return view(load());
}

/** Создать страницу (пустую или с готовым документом) и сделать её активной. */
export function create(docText: string | null, after?: string): PageMeta {
  const idx = load();
  const id = newId();
  const text = docText ?? "";
  if (text.length > MAX_DOC) throw new Error("too_large");
  if (text) fs.writeFileSync(path.join(pagesDir(), `${id}.json`), text);
  else fs.writeFileSync(path.join(pagesDir(), `${id}.json`), "");
  const info = text ? describeDoc(text) : { title: "", screens: 0, parts: 0 };
  const now = Date.now();
  const meta: PageMeta = {
    id,
    title: info.title,
    createdAt: now,
    updatedAt: now,
    screens: info.screens,
    parts: info.parts,
  };
  idx.pages[id] = meta;
  const at = after && idx.order.includes(after) ? idx.order.indexOf(after) + 1 : idx.order.length;
  idx.order.splice(at, 0, id);
  idx.activeId = id;
  save(idx);
  return meta;
}

export function read(id: string): string | null {
  if (!isId(id)) return null;
  const f = path.join(pagesDir(), `${id}.json`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}

/** Записать документ страницы (текст JSON) и обновить сведения в списке. */
export function write(id: string, text: string): PageMeta | null {
  if (!isId(id) || text.length > MAX_DOC) return null;
  const idx = load();
  const meta = idx.pages[id];
  if (!meta) return null;
  const info = describeDoc(text);
  writeAtomic(path.join(pagesDir(), `${id}.json`), text);
  meta.title = info.title;
  meta.screens = info.screens;
  meta.parts = info.parts;
  meta.updatedAt = Date.now();
  save(idx);
  return meta;
}

export interface Patch {
  activeId?: string;
  order?: string[];
  pages?: Record<string, { pinned?: boolean; color?: string | null }>;
}

/** Порядок страниц, активная страница, закрепление и цвет вкладки. */
export function patch(p: Patch): Workbook {
  const idx = load();
  if (typeof p.activeId === "string" && idx.pages[p.activeId]) idx.activeId = p.activeId;
  if (Array.isArray(p.order)) {
    const ids = p.order.filter((id) => idx.pages[id]);
    const rest = idx.order.filter((id) => !ids.includes(id));
    idx.order = [...ids, ...rest];
  }
  if (p.pages && typeof p.pages === "object") {
    for (const [id, v] of Object.entries(p.pages)) {
      const m = idx.pages[id];
      if (!m || !v || typeof v !== "object") continue;
      if (typeof v.pinned === "boolean") m.pinned = v.pinned || undefined;
      if (v.color === null) delete m.color;
      else if (typeof v.color === "string" && /^#[0-9a-fA-F]{6}$/.test(v.color)) m.color = v.color;
    }
  }
  save(idx);
  return view(idx);
}

/** Копия страницы справа от оригинала. */
export function duplicate(id: string, title: string): PageMeta | null {
  const text = read(id);
  if (text === null) return null;
  let next = text;
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    d.title = title;
    next = JSON.stringify(d);
  } catch {
    /* пустая страница копируется как есть */
  }
  const meta = create(next, id);
  return meta;
}

/** Убрать страницу в корзину. Активной становится соседняя. */
export function remove(id: string): Workbook | null {
  const idx = load();
  const meta = idx.pages[id];
  if (!meta) return null;
  fs.renameSync(path.join(pagesDir(), `${id}.json`), path.join(trashDir(), `${id}.json`));
  idx.trash[id] = { ...meta, deletedAt: Date.now() };
  const at = idx.order.indexOf(id);
  delete idx.pages[id];
  idx.order = idx.order.filter((x) => x !== id);
  if (idx.activeId === id) idx.activeId = idx.order[Math.min(at, idx.order.length - 1)] ?? null;
  save(idx);
  return view(idx);
}

export function restore(id: string): Workbook | null {
  const idx = load();
  const meta = idx.trash[id];
  if (!meta) return null;
  fs.renameSync(path.join(trashDir(), `${id}.json`), path.join(pagesDir(), `${id}.json`));
  const { deletedAt: _d, ...rest } = meta;
  void _d;
  idx.pages[id] = rest;
  idx.order.push(id);
  idx.activeId = id;
  delete idx.trash[id];
  save(idx);
  return view(idx);
}

export function purge(id: string): Workbook | null {
  const idx = load();
  if (!idx.trash[id]) return null;
  fs.rmSync(path.join(trashDir(), `${id}.json`), { force: true });
  delete idx.trash[id];
  save(idx);
  return view(idx);
}
