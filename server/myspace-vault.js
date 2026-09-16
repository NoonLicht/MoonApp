"use strict";

/**
 * Vault (MySpace) — файловое хранение заметок, папок и canvas.
 * Каждая заметка = .md файл в storage/vault/notes/
 * Canvas = .holst JSON-файлы в storage/vault/holts/
 * Поддержка YAML frontmatter, [[WikiLinks]], тегов.
 */

const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const logger = require("./logger");
// Заметки пользователя почти всегда названы по-русски, а fs.rmSync такие файлы
// на Windows молча не удаляет — см. комментарий в server/ts/fsUtil.ts.
const { removePath } = require("./fsUtil");

const VAULT_DIR = path.join(DIRS.storage, "vault");
const NOTEBOOK_DIR = path.join(VAULT_DIR, "notes");
const HOLST_DIR = path.join(VAULT_DIR, "holts");

function ensureDirs() {
  for (const d of [VAULT_DIR, NOTEBOOK_DIR, HOLST_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// Контейнмент путей (защита от path traversal): клиентский путь разрешается
// внутри базовой папки. resolve + проверка префикса — любой "../../.." даёт
// null, и операция отклоняется вместо выхода за пределы vault.
function safeJoin(baseDir, relPath) {
  const rel = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const full = path.resolve(baseDir, rel);
  const base = path.resolve(baseDir);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function buildTree(dir, basePath = "") {
  const tree = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return tree;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = basePath ? basePath + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      tree.push({
        name: entry.name,
        path: relPath,
        type: "folder",
        children: buildTree(path.join(dir, entry.name), relPath),
      });
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".holst")) {
      tree.push({
        name: entry.name,
        path: relPath,
        type: entry.name.endsWith(".holst") ? "holst" : "note",
        ext: path.extname(entry.name),
      });
    }
  }
  return tree;
}

function readFile(filePath) {
  const fullPath = safeJoin(NOTEBOOK_DIR, filePath);
  if (!fullPath || !fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, "utf8");
  const meta = { path: filePath, name: path.basename(filePath), ext: path.extname(filePath) };
  let content = raw;
  let frontmatter = {};
  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("---", 3);
    if (endIdx > 0) {
      const fmBlock = raw.slice(3, endIdx).trim();
      content = raw.slice(endIdx + 3).trimStart();
      for (const line of fmBlock.split("\n")) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        )
          val = val.slice(1, -1);
        frontmatter[key] = val;
      }
    }
  }
  const tags = [...content.matchAll(/(?:^|\s)(#[a-zA-Zа-яА-Я0-9_/-]+)/g)].map((m) => m[1]);
  const wikiLinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  return { ...meta, content, frontmatter, tags, wikiLinks };
}

function writeFile(filePath, content, frontmatter = {}) {
  ensureDirs();
  const fullPath = safeJoin(NOTEBOOK_DIR, filePath);
  if (!fullPath) return { ok: false, error: "forbidden path" };
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let md = "";
  if (frontmatter && Object.keys(frontmatter).length > 0) {
    md = "---\n";
    for (const [k, v] of Object.entries(frontmatter)) {
      md += `${k}: "${String(v).replace(/"/g, '\\"')}"\n`;
    }
    md += "---\n\n";
  }
  md += content || "";
  fs.writeFileSync(fullPath, md, "utf8");
  return { path: filePath, ok: true };
}

function deleteFile(filePath) {
  const fullPath = safeJoin(NOTEBOOK_DIR, filePath);
  if (!fullPath) return { ok: false, error: "forbidden path" };
  try {
    if (fs.existsSync(fullPath)) {
      // Именно removePath, а не fs.rmSync: на Windows rmSync молча не удаляет
      // файлы с кириллическими именами, поэтому «удалить заметку» возвращало
      // успех, а .md оставался на диске (см. server/ts/fsUtil.ts).
      if (!removePath(fullPath)) return { ok: false, error: "delete_failed" };
      return { ok: true };
    }
    return { ok: false, error: "not found" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function renameFile(oldPath, newPath) {
  const oldFull = safeJoin(NOTEBOOK_DIR, oldPath);
  const newFull = safeJoin(NOTEBOOK_DIR, newPath);
  if (!oldFull || !newFull) return { ok: false, error: "forbidden path" };
  try {
    const dir = path.dirname(newFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(oldFull, newFull);
    return { ok: true, newPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function createFolder(folderPath) {
  const fullPath = safeJoin(NOTEBOOK_DIR, folderPath);
  if (!fullPath) return { ok: false, error: "forbidden path" };
  try {
    fs.mkdirSync(fullPath, { recursive: true });
    return { ok: true, path: folderPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function searchFiles(query) {
  const q = String(query || "")
    .toLowerCase()
    .trim();
  if (!q) return [];
  const results = [];
  function walk(dir, basePath) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = basePath ? basePath + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith(".md")) {
        const fpath = path.join(dir, entry.name);
        const c = fs.readFileSync(fpath, "utf8");
        if (c.toLowerCase().includes(q)) {
          const idx = c.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 60);
          const end = Math.min(c.length, idx + q.length + 60);
          results.push({
            path: relPath,
            name: entry.name,
            snippet: c.slice(start, end).replace(/\n/g, " "),
            matchStart: idx,
          });
        }
      }
    }
  }
  walk(NOTEBOOK_DIR, "");
  return results;
}
function getAllTags() {
  const tagMap = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".md")) {
        const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
        const tags = [...raw.matchAll(/(?:^|\s)(#[a-zA-Zа-яА-Я0-9_/-]+)/g)].map((m) => m[1]);
        for (const tag of tags) tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
      }
    }
  }
  walk(NOTEBOOK_DIR);
  return Array.from(tagMap.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

function getBacklinks(targetPath) {
  const targetName = path.basename(targetPath, ".md");
  const backlinks = [];
  function walk(dir, basePath) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = basePath ? basePath + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith(".md") && relPath !== targetPath) {
        const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
        const hasDirect = raw.includes(`[[${targetName}]]`);
        const hasUnlinked = !hasDirect && raw.toLowerCase().includes(targetName.toLowerCase());
        if (hasDirect || hasUnlinked) {
          const idx = hasDirect
            ? raw.indexOf(`[[${targetName}]]`)
            : raw.toLowerCase().indexOf(targetName.toLowerCase());
          const start = Math.max(0, idx - 60);
          const end = Math.min(raw.length, idx + targetName.length + 60 + (hasDirect ? 4 : 0));
          backlinks.push({
            path: relPath,
            name: entry.name.replace(".md", ""),
            type: hasDirect ? "linked" : "unlinked",
            snippet: raw.slice(start, end).replace(/\n/g, " "),
          });
        }
      }
    }
  }
  walk(NOTEBOOK_DIR);
  return backlinks;
}

function getOutline(content) {
  const headers = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) headers.push({ level: match[1].length, text: match[2].trim(), line: i + 1 });
  }
  return headers;
}

/* ======================== Holst / Canvas ======================== */

/**
 * List all .holst files.
 */
function listHolsts() {
  ensureDirs();
  const items = [];
  try {
    const entries = fs.readdirSync(HOLST_DIR, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.endsWith(".holst")) {
        const fullPath = path.join(HOLST_DIR, entry.name);
        try {
          const raw = fs.readFileSync(fullPath, "utf8");
          const data = JSON.parse(raw);
          items.push({
            name: entry.name.replace(".holst", ""),
            path: entry.name,
            updatedAt: data.meta?.updatedAt || data.updatedAt || null,
            thumbnail: data.meta?.thumbnail || null,
          });
        } catch {
          /* skip corrupt */
        }
      }
    }
  } catch {
    /* empty */
  }
  return items;
}

/**
 * Read a .holst file by name (without extension).
 */
function readHolst(name) {
  ensureDirs();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fullPath = path.join(HOLST_DIR, `${safeName}.holst`);
  if (!fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, "utf8");
  try {
    const data = JSON.parse(raw);
    return { name: safeName, data };
  } catch (e) {
    return { name: safeName, data: null, error: "Invalid JSON" };
  }
}

/**
 * Write a .holst file. Expects { name, data } where data is the full tldraw store snapshot.
 */
function writeHolst(name, data) {
  ensureDirs();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fullPath = path.join(HOLST_DIR, `${safeName}.holst`);
  const payload = {
    meta: {
      updatedAt: new Date().toISOString(),
      name: safeName,
    },
    ...data,
  };
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), "utf8");
  logger.action("holst.write", { name: safeName });
  return { ok: true, name: safeName };
}

/**
 * Delete a .holst file.
 */
function deleteHolst(name) {
  ensureDirs();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fullPath = path.join(HOLST_DIR, `${safeName}.holst`);
  if (!fs.existsSync(fullPath)) return { ok: false, error: "Not found" };
  fs.unlinkSync(fullPath);
  logger.action("holst.delete", { name: safeName });
  return { ok: true };
}

ensureDirs();

module.exports = {
  buildTree: () => buildTree(NOTEBOOK_DIR),
  readFile: (p) => readFile(p),
  writeFile: (p, c, fm) => writeFile(p, c, fm),
  deleteFile: (p) => deleteFile(p),
  renameFile: (o, n) => renameFile(o, n),
  createFolder: (p) => createFolder(p),
  searchFiles: (q) => searchFiles(q),
  getAllTags: () => getAllTags(),
  getBacklinks: (p) => getBacklinks(p),
  getOutline: (c) => getOutline(c),
  listHolsts: () => listHolsts(),
  readHolst: (n) => readHolst(n),
  writeHolst: (n, d) => writeHolst(n, d),
  deleteHolst: (n) => deleteHolst(n),
  VAULT_DIR,
  NOTEBOOK_DIR,
  HOLST_DIR,
};
