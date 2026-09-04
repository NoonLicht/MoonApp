"use strict";

/**
 * Vault (MySpace) — файловое хранение заметок, папок и canvas.
 * Каждая заметка = .md файл в storage/vault/notes/
 * Canvas = .canvas JSON-файлы в storage/vault/canvases/
 * Поддержка YAML frontmatter, [[WikiLinks]], тегов.
 */

const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const logger = require("./logger");

const VAULT_DIR = path.join(DIRS.storage, "vault");
const NOTEBOOK_DIR = path.join(VAULT_DIR, "notes");
const CANVAS_DIR = path.join(VAULT_DIR, "canvases");

function ensureDirs() {
  for (const d of [VAULT_DIR, NOTEBOOK_DIR, CANVAS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function slugify(title) {
  return String(title || "untitled")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9_\-]/gi, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "note";
}

function buildTree(dir, basePath = "") {
  const tree = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return tree; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = basePath ? basePath + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      tree.push({
        name: entry.name, path: relPath, type: "folder",
        children: buildTree(path.join(dir, entry.name), relPath),
      });
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".canvas")) {
      tree.push({
        name: entry.name, path: relPath,
        type: entry.name.endsWith(".canvas") ? "canvas" : "note",
        ext: path.extname(entry.name),
      });
    }
  }
  return tree;
}

function readFile(filePath) {
  const fullPath = path.join(NOTEBOOK_DIR, filePath);
  if (!fs.existsSync(fullPath)) return null;
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
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        frontmatter[key] = val;
      }
    }
  }
  const tags = [...content.matchAll(/(?:^|\s)(#[a-zA-Zа-яА-Я0-9_\/\-]+)/g)].map(m => m[1]);
  const wikiLinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
  return { ...meta, content, frontmatter, tags, wikiLinks };
}

function writeFile(filePath, content, frontmatter = {}) {
  ensureDirs();
  const fullPath = path.join(NOTEBOOK_DIR, filePath);
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
  const fullPath = path.join(NOTEBOOK_DIR, filePath);
  try {
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { force: true }); return { ok: true };
    }
    const dirPath = path.join(VAULT_DIR, "notes", filePath);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      fs.rmSync(dirPath, { recursive: true, force: true }); return { ok: true };
    }
    return { ok: false, error: "not found" };
  } catch (e) { return { ok: false, error: e.message }; }
}

function renameFile(oldPath, newPath) {
  const oldFull = path.join(NOTEBOOK_DIR, oldPath);
  const newFull = path.join(NOTEBOOK_DIR, newPath);
  try {
    const dir = path.dirname(newFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(oldFull, newFull);
    return { ok: true, newPath };
  } catch (e) { return { ok: false, error: e.message }; }
}

function createFolder(folderPath) {
  const fullPath = path.join(NOTEBOOK_DIR, folderPath);
  try {
    fs.mkdirSync(fullPath, { recursive: true });
    return { ok: true, path: folderPath };
  } catch (e) { return { ok: false, error: e.message }; }
}

function searchFiles(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  const results = [];
  function walk(dir, basePath) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relPath = basePath ? basePath + "/" + entry.name : entry.name;
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), relPath); }
      else if (entry.name.endsWith(".md")) {
        const fpath = path.join(dir, entry.name);
        const c = fs.readFileSync(fpath, "utf8");
        if (c.toLowerCase().includes(q)) {
          const idx = c.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 60);
          const end = Math.min(c.length, idx + q.length + 60);
          results.push({ path: relPath, name: entry.name, snippet: c.slice(start, end).replace(/\n/g, " "), matchStart: idx });
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
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { walk(path.join(dir, entry.name)); }
      else if (entry.name.endsWith(".md")) {
        const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
        const tags = [...raw.matchAll(/(?:^|\s)(#[a-zA-Zа-яА-Я0-9_\/\-]+)/g)].map(m => m[1]);
        for (const tag of tags) tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
      }
    }
  }
  walk(NOTEBOOK_DIR);
  return Array.from(tagMap.entries()).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

function getBacklinks(targetPath) {
  const targetName = path.basename(targetPath, ".md");
  const backlinks = [];
  function walk(dir, basePath) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relPath = basePath ? basePath + "/" + entry.name : entry.name;
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), relPath); }
      else if (entry.name.endsWith(".md") && relPath !== targetPath) {
        const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
        const hasDirect = raw.includes(`[[${targetName}]]`);
        const hasUnlinked = !hasDirect && raw.toLowerCase().includes(targetName.toLowerCase());
        if (hasDirect || hasUnlinked) {
          const idx = hasDirect ? raw.indexOf(`[[${targetName}]]`) : raw.toLowerCase().indexOf(targetName.toLowerCase());
          const start = Math.max(0, idx - 60);
          const end = Math.min(raw.length, idx + targetName.length + 60 + (hasDirect ? 4 : 0));
          backlinks.push({
            path: relPath, name: entry.name.replace(".md", ""),
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

// Canvas operations
function readCanvas(name) {
  const fp = path.join(CANVAS_DIR, name.endsWith(".canvas") ? name : name + ".canvas");
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function writeCanvas(name, data) {
  ensureDirs();
  const fp = path.join(CANVAS_DIR, name.endsWith(".canvas") ? name : name + ".canvas");
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf8");
  return { ok: true };
}

function listCanvases() {
  ensureDirs();
  let files = [];
  try { files = fs.readdirSync(CANVAS_DIR); } catch {}
  return files.filter(f => f.endsWith(".canvas")).map(f => ({ name: f.replace(".canvas", ""), path: f }));
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
  readCanvas: (n) => readCanvas(n),
  writeCanvas: (n, d) => writeCanvas(n, d),
  listCanvases: () => listCanvases(),
  VAULT_DIR, NOTEBOOK_DIR, CANVAS_DIR,
};
