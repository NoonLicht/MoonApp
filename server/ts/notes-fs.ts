/**
 * Файловое хранение заметок в отдельных .md файлах.
 *
 * Каждая заметка = файл в storage/notes/{id}-{slug}.md
 * Формат: YAML frontmatter + тело — markdown.
 * В памяти держится noteMap для быстрых запросов.
 * При мутации — перезаписывается только изменившийся .md файл.
 *
 * TS-исходник, как server/ts/frontmatter.ts: компилируется в server/notes-fs.js
 * командой `npm run compile:server`, поэтому `require("./notes-fs")` из роутов
 * и lecture.js продолжает работать (включая имя `delete` для удаления заметки).
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
// Удаление файлов с кириллическими именами: fs.rmSync на Windows этого молча
// не делает, а заголовки заметок почти всегда русские (см. server/ts/fsUtil.ts).
import { removePath } from "./fsUtil";
import { parseFrontmatter } from "./frontmatter";

const { DIRS } = config;

const NOTES_DIR = path.join(DIRS.storage, "notes");

/** Заметка в том виде, в каком она живёт в памяти и в .md-файле. */
export interface Note {
  id: number;
  title: string;
  content: string;
  tags: string;
  folder: string;
  created_at: string;
  updated_at: string;
}

/** Поля, которые можно задать при upsert (остальные берутся из прежней версии). */
export interface NoteFields {
  title?: unknown;
  content?: unknown;
  tags?: unknown;
  folder?: unknown;
}

let noteMap = new Map<number, Note>();
let noteSeq = 0;

function ensureDir(): void {
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function slugify(title: unknown): string {
  return (
    String(title || "untitled")
      .toLowerCase()
      .replace(/[^a-zа-яё0-9_-]/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "note"
  );
}

function noteFilename(note: Note): string {
  return note.id + "-" + slugify(note.title) + ".md";
}

function notePath(note: Note): string {
  return path.join(NOTES_DIR, noteFilename(note));
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** Сериализовать заметку в .md с frontmatter. */
function serializeNote(note: Note): string {
  const fm = ["---", 'title: "' + (note.title || "").replace(/"/g, '\\"') + '"', "id: " + note.id];
  if (note.tags) fm.push('tags: "' + (note.tags || "").replace(/"/g, '\\"') + '"');
  if (note.folder) fm.push('folder: "' + (note.folder || "").replace(/"/g, '\\"') + '"');
  fm.push("created_at: " + (note.created_at || ""));
  fm.push("updated_at: " + (note.updated_at || ""));
  fm.push("---", "", note.content || "");
  return fm.join("\n");
}

/** Распарсить .md файл → заметка (id берётся из frontmatter или имени файла). */
function parseNote(filePath: string): Note {
  const raw = fs.readFileSync(filePath, "utf8");
  const note: Note = {
    id: 0,
    title: "",
    content: "",
    tags: "",
    folder: "",
    created_at: "",
    updated_at: "",
  };
  const { hasFrontmatter, frontmatter, content } = parseFrontmatter(raw);
  if (hasFrontmatter) {
    note.content = content;
    for (const [key, val] of Object.entries(frontmatter)) {
      if (key === "title") note.title = val;
      else if (key === "id") note.id = Number(val) || 0;
      else if (key === "tags") note.tags = val;
      else if (key === "folder") note.folder = val;
      else if (key === "created_at") note.created_at = val;
      else if (key === "updated_at") note.updated_at = val;
    }
    return note;
  }
  note.content = raw;
  const base = path.basename(filePath, ".md");
  const match = base.match(/^\d+-(.+)$/);
  note.title = match ? match[1] : base;
  return note;
}

/** Записать заметку в её файл, убрав прежний файл с тем же id (смена заголовка → смена slug). */
function writeNoteFile(note: Note): void {
  ensureDir();
  const newPath = notePath(note);
  let oldPath: string | null = null;
  try {
    const files = fs.readdirSync(NOTES_DIR);
    for (const f of files) {
      if (f.startsWith(note.id + "-")) {
        const fp = path.join(NOTES_DIR, f);
        if (fp !== newPath) oldPath = fp;
      }
    }
  } catch {
    /* каталога нет — писать всё равно будем, ensureDir его создал */
  }
  if (oldPath) removeNoteFileByPath(oldPath);
  fs.writeFileSync(newPath, serializeNote(note), "utf8");
}

/** Стереть файл заметки, честно сообщив в лог, если он остался на диске. */
function removeNoteFileByPath(filePath: string): void {
  if (!removePath(filePath)) logger.warn("notes-fs.remove_failed", { file: filePath });
}

function removeNoteFile(note: Note): void {
  try {
    const files = fs.readdirSync(NOTES_DIR);
    for (const f of files)
      if (f.startsWith(note.id + "-")) removeNoteFileByPath(path.join(NOTES_DIR, f));
  } catch {
    /* каталога нет — удалять нечего */
  }
}

// --- Публичное API ---

/** Загрузить все заметки с диска (при старте). */
export function loadAll(): void {
  ensureDir();
  noteMap = new Map();
  noteSeq = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(NOTES_DIR);
  } catch {
    /* пустой каталог — просто нет заметок */
  }
  for (const f of files.sort()) {
    if (!f.endsWith(".md")) continue;
    try {
      const note = parseNote(path.join(NOTES_DIR, f));
      if (note.id > 0) {
        noteMap.set(note.id, note);
        if (note.id > noteSeq) noteSeq = note.id;
      }
    } catch (e) {
      logger.warn("notes-fs.parse_error", { file: f, error: (e as Error).message });
    }
  }
  logger.info("notes-fs.loaded", { count: noteMap.size });
}

/** Все заметки, свежие сначала (сортировка по updated_at/created_at). */
export function all(): Note[] {
  const list = Array.from(noteMap.values());
  list.sort((a, b) => {
    const da = a.updated_at || a.created_at || "";
    const db = b.updated_at || b.created_at || "";
    return da > db ? -1 : da < db ? 1 : 0;
  });
  return list.map((r) => ({ ...r }));
}

export function get(id: number): Note | undefined {
  const r = noteMap.get(id);
  return r ? { ...r } : undefined;
}

export function insert(
  title: unknown,
  content: unknown,
  tags: unknown,
  folder: unknown,
): { lastInsertRowid: number } {
  const id = ++noteSeq;
  const ts = now();
  const note: Note = {
    id,
    title: String(title || ""),
    content: String(content || ""),
    tags: String(tags || ""),
    folder: String(folder || ""),
    created_at: ts,
    updated_at: ts,
  };
  noteMap.set(id, note);
  writeNoteFile(note);
  return { lastInsertRowid: id };
}

export function update(
  title: unknown,
  content: unknown,
  tags: unknown,
  folder: unknown,
  id: number,
): { changes: number } {
  const ex = noteMap.get(id);
  if (!ex) return { changes: 0 };
  const updated: Note = {
    ...ex,
    title: title != null ? String(title).trim() : ex.title,
    content: content != null ? String(content) : ex.content,
    tags: tags != null ? String(tags) : ex.tags,
    folder: folder != null ? String(folder) : ex.folder,
    updated_at: now(),
  };
  noteMap.set(id, updated);
  writeNoteFile(updated);
  return { changes: 1 };
}

/**
 * Запись заметки с ЯВНО заданным id (0/пусто — «создай новую»).
 *
 * Нужна внешним источникам, которые держат ссылку на файл: заметки лекций
 * (см. server/lecture.js → syncNotesFile) знают id заметки и перезаписывают
 * ровно один и тот же .md. Отличие от update(): если файла нет в noteMap (его
 * удалили с диска вручную), заметка создаётся заново с тем же id — иначе
 * синхронизация молча теряла бы конспект, а при «обновлении» ничего не писала.
 */
export function upsert(id: number, fields: NoteFields = {}): Note {
  const wanted = Number(id) > 0 ? Number(id) : noteSeq + 1;
  const ts = now();
  const ex = noteMap.get(wanted);
  const note: Note = {
    id: wanted,
    title: fields.title != null ? String(fields.title) : ex ? ex.title : "",
    content: fields.content != null ? String(fields.content) : ex ? ex.content : "",
    tags: fields.tags != null ? String(fields.tags) : ex ? ex.tags : "",
    folder: fields.folder != null ? String(fields.folder) : ex ? ex.folder : "",
    // created_at переживает перезапись: это дата появления заметки, а не правки.
    created_at: ex ? ex.created_at : ts,
    updated_at: ts,
  };
  if (wanted > noteSeq) noteSeq = wanted;
  noteMap.set(wanted, note);
  writeNoteFile(note);
  return { ...note };
}

/** Удалить заметку (экспортируется как `delete` — имя сохранено из .js-модуля). */
function del(id: number): { changes: number } {
  const note = noteMap.get(id);
  if (!note) return { changes: 0 };
  removeNoteFile(note);
  noteMap.delete(id);
  return { changes: 1 };
}

export { del as delete };

export function deleteAll(): { deleted: number } {
  const count = noteMap.size;
  noteMap.clear();
  try {
    const files = fs.readdirSync(NOTES_DIR);
    for (const f of files) if (f.endsWith(".md")) removeNoteFileByPath(path.join(NOTES_DIR, f));
  } catch {
    /* каталога нет — удалять нечего */
  }
  noteSeq = 0;
  return { deleted: count };
}

/** Поиск по заголовку и телу (регистронезависимый). */
export function search(q: unknown): Note[] {
  const query = String(q || "")
    .toLowerCase()
    .trim();
  if (!query) return [];
  return Array.from(noteMap.values())
    .filter((n) => n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query))
    .map((r) => ({ ...r }));
}

export { NOTES_DIR };

/** Загрузить, если директория существует (модуль читает диск уже при require). */
loadAll();
