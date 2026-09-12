"use strict";

/**
 * Файловое хранение заметок в отдельных .md файлах.
 *
 * Каждая заметка = файл в storage/notes/{id}-{slug}.md
 * Формат: YAML frontmatter + тело — markdown.
 * В памяти держится noteMap для быстрых запросов.
 * При мутации — перезаписывается только изменившийся .md файл.
 */

const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const logger = require("./logger");

const NOTES_DIR = path.join(DIRS.storage, "notes");
let noteMap = new Map();
let noteSeq = 0;

function ensureDir() {
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function slugify(title) {
  return String(title || "untitled")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9_\-]/gi, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "note";
}

function noteFilename(note) {
  return note.id + "-" + slugify(note.title) + ".md";
}

function notePath(note) {
  return path.join(NOTES_DIR, noteFilename(note));
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
// Сериализовать заметку в .md с frontmatter
function serializeNote(note) {
  const fm = [
    "---",
    'title: "' + (note.title || "").replace(/"/g, '\\"') + '"',
    "id: " + note.id,
  ];
  if (note.tags) fm.push('tags: "' + (note.tags || "").replace(/"/g, '\\"') + '"');
  if (note.folder) fm.push('folder: "' + (note.folder || "").replace(/"/g, '\\"') + '"');
  fm.push("created_at: " + (note.created_at || ""));
  fm.push("updated_at: " + (note.updated_at || ""));
  fm.push("---", "", note.content || "");
  return fm.join("\n");
}

// Распарсить .md файл -> note-объект
function parseNote(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const note = { id: 0, title: "", content: "", tags: "", folder: "", created_at: "", updated_at: "" };
  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("---", 3);
    if (endIdx > 0) {
      const fmBlock = raw.slice(3, endIdx).trim();
      note.content = raw.slice(endIdx + 3).trimStart();
      for (const line of fmBlock.split("\n")) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (key === "title") note.title = val;
        else if (key === "id") note.id = Number(val) || 0;
        else if (key === "tags") note.tags = val;
        else if (key === "folder") note.folder = val;
        else if (key === "created_at") note.created_at = val;
        else if (key === "updated_at") note.updated_at = val;
      }
      return note;
    }
  }
  note.content = raw;
  const base = path.basename(filePath, ".md");
  const match = base.match(/^\d+-(.+)$/);
  note.title = match ? match[1] : base;
  return note;
}

function writeNoteFile(note) {
  ensureDir();
  const newPath = notePath(note);
  let oldPath = null;
  try {
    const files = fs.readdirSync(NOTES_DIR);
    for (const f of files) {
      if (f.startsWith(note.id + "-")) { const fp = path.join(NOTES_DIR, f); if (fp !== newPath) oldPath = fp; }
    }
  } catch {}
  if (oldPath) try { fs.rmSync(oldPath, { force: true }); } catch {}
  fs.writeFileSync(newPath, serializeNote(note), "utf8");
}

function removeNoteFile(note) {
  try {
    const files = fs.readdirSync(NOTES_DIR);
    for (const f of files) if (f.startsWith(note.id + "-")) fs.rmSync(path.join(NOTES_DIR, f), { force: true });
  } catch {}
}

// --- Публичное API ---

/** Загрузить все заметки с диска (при старте). */
function loadAll() {
  ensureDir();
  noteMap = new Map();
  noteSeq = 0;
  let files = [];
  try { files = fs.readdirSync(NOTES_DIR); } catch {}
  for (const f of files.sort()) {
    if (!f.endsWith(".md")) continue;
    try {
      const note = parseNote(path.join(NOTES_DIR, f));
      if (note.id > 0) {
        noteMap.set(note.id, note);
        if (note.id > noteSeq) noteSeq = note.id;
      }
    } catch (e) {
      logger.warn("notes-fs.parse_error", { file: f, error: e.message });
    }
  }
  logger.info("notes-fs.loaded", { count: noteMap.size });
}

function all() {
  const list = Array.from(noteMap.values());
  list.sort((a, b) => {
    const da = a.updated_at || a.created_at || "";
    const db = b.updated_at || b.created_at || "";
    return da > db ? -1 : da < db ? 1 : 0;
  });
  return list.map(r => ({ ...r }));
}

function get(id) {
  const r = noteMap.get(id);
  return r ? { ...r } : undefined;
}

function insert(title, content, tags, folder) {
  const id = ++noteSeq;
  const ts = now();
  const note = { id, title: String(title || ""), content: String(content || ""), tags: String(tags || ""), folder: String(folder || ""), created_at: ts, updated_at: ts };
  noteMap.set(id, note);
  writeNoteFile(note);
  return { lastInsertRowid: id };
}

function update(title, content, tags, folder, id) {
  const ex = noteMap.get(id);
  if (!ex) return { changes: 0 };
  const updated = {
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

function del(id) {
  const note = noteMap.get(id);
  if (!note) return { changes: 0 };
  removeNoteFile(note);
  noteMap.delete(id);
  return { changes: 1 };
}

function deleteAll() {
  const count = noteMap.size;
  noteMap.clear();
  try {
    const files = fs.readdirSync(NOTES_DIR);
    for (const f of files) if (f.endsWith(".md")) fs.rmSync(path.join(NOTES_DIR, f), { force: true });
  } catch {}
  noteSeq = 0;
  return { deleted: count };
}

function search(q) {
  const query = String(q || "").toLowerCase().trim();
  if (!query) return [];
  return Array.from(noteMap.values()).filter(n =>
    n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query)
  ).map(r => ({ ...r }));
}

/** Загрузить, если директория существует */
loadAll();

module.exports = { loadAll, all, get, insert, update, delete: del, deleteAll, search, NOTES_DIR };