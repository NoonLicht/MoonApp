/**
 * Vault (MySpace) — файловое хранение заметок, папок и canvas.
 * Каждая заметка = .md файл в storage/vault/notes/
 * Canvas = .holst JSON-файлы в storage/vault/holts/
 * Поддержка YAML frontmatter, [[WikiLinks]], тегов.
 *
 * TS-исходник, как server/ts/notes-fs.ts: компилируется в server/myspace-vault.js
 * командой `npm run compile:server`, поэтому `require("../myspace-vault")` из
 * server/routes/myspace.js и тестов продолжает работать с теми же именами.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
// Заметки пользователя почти всегда названы по-русски, а fs.rmSync такие файлы
// на Windows молча не удаляет — см. комментарий в server/ts/fsUtil.ts.
import { removePath } from "./fsUtil";
import { parseFrontmatter } from "./frontmatter";

const { DIRS } = config;

const VAULT_DIR = DIRS.vault;
const NOTEBOOK_DIR = DIRS.vaultNotes;
const HOLST_DIR = DIRS.vaultHolts;

/** Узел дерева заметок: папка (с детьми) либо файл .md/.holst. */
export interface VaultTreeItem {
  name: string;
  path: string;
  type: "folder" | "note" | "holst";
  ext?: string;
  children?: VaultTreeItem[];
}

/** Заметка, отданная на фронт: мета + тело без frontmatter + извлечённые ссылки. */
export interface VaultFileData {
  path: string;
  name: string;
  ext: string;
  content: string;
  frontmatter: Record<string, string>;
  tags: string[];
  wikiLinks: string[];
}

/** Результат файловой операции. error заполняется только при ok: false. */
export interface VaultOpResult {
  ok: boolean;
  error?: string;
  path?: string;
  newPath?: string;
}

export interface VaultSearchHit {
  path: string;
  name: string;
  snippet: string;
  matchStart: number;
}

export interface VaultTagCount {
  tag: string;
  count: number;
}

export interface VaultBacklink {
  path: string;
  name: string;
  type: "linked" | "unlinked";
  snippet: string;
}

export interface VaultOutlineHeader {
  level: number;
  text: string;
  line: number;
}

export interface VaultHolstSummary {
  name: string;
  path: string;
  updatedAt: string | null;
  thumbnail: string | null;
}

function ensureDirs(): void {
  for (const d of [VAULT_DIR, NOTEBOOK_DIR, HOLST_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// Контейнмент путей (защита от path traversal): клиентский путь разрешается
// внутри базовой папки. resolve + проверка префикса — любой "../../.." даёт
// null, и операция отклоняется вместо выхода за пределы vault.
function safeJoin(baseDir: string, relPath: unknown): string | null {
  const rel = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const full = path.resolve(baseDir, rel);
  const base = path.resolve(baseDir);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}
/**
 * Служебные записи vault скрыты от проводника заметок: папка .ai с «сырыми»
 * исходниками ИИ-оформления (server/ts/notesAi.ts) не должна висеть в дереве
 * пустой папкой — .txt-исходники в дерево всё равно не попадают.
 */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

// Внутренний обход дерева (dir — произвольная папка); публичная точка входа
// buildTree() ниже жёстко привязана к папке заметок, как в .js-версии модуля.
function walkTree(dir: string, basePath = ""): VaultTreeItem[] {
  const tree: VaultTreeItem[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return tree;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isHidden(entry.name)) continue;
    const relPath = basePath ? basePath + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      tree.push({
        name: entry.name,
        path: relPath,
        type: "folder",
        children: walkTree(path.join(dir, entry.name), relPath),
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

function readFile(filePath: string): VaultFileData | null {
  const fullPath = safeJoin(NOTEBOOK_DIR, filePath);
  if (!fullPath || !fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, "utf8");
  const meta = { path: filePath, name: path.basename(filePath), ext: path.extname(filePath) };
  const { frontmatter, content } = parseFrontmatter(raw);
  const tags = [...content.matchAll(/(?:^|\s)(#[a-zA-Zа-яА-Я0-9_/-]+)/g)].map((m) => m[1]);
  const wikiLinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  return { ...meta, content, frontmatter, tags, wikiLinks };
}

function writeFile(
  filePath: string,
  content: unknown,
  frontmatter: Record<string, unknown> = {},
): VaultOpResult {
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
  md += String(content || "");
  fs.writeFileSync(fullPath, md, "utf8");
  return { path: filePath, ok: true };
}

function deleteFile(filePath: string): VaultOpResult {
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
    return { ok: false, error: (e as Error).message };
  }
}

function renameFile(oldPath: string, newPath: string): VaultOpResult {
  const oldFull = safeJoin(NOTEBOOK_DIR, oldPath);
  const newFull = safeJoin(NOTEBOOK_DIR, newPath);
  if (!oldFull || !newFull) return { ok: false, error: "forbidden path" };
  try {
    const dir = path.dirname(newFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(oldFull, newFull);
    return { ok: true, newPath };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function createFolder(folderPath: string): VaultOpResult {
  const fullPath = safeJoin(NOTEBOOK_DIR, folderPath);
  if (!fullPath) return { ok: false, error: "forbidden path" };
  try {
    fs.mkdirSync(fullPath, { recursive: true });
    return { ok: true, path: folderPath };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
function searchFiles(query: unknown): VaultSearchHit[] {
  const q = String(query || "")
    .toLowerCase()
    .trim();
  if (!q) return [];
  const results: VaultSearchHit[] = [];
  function walk(dir: string, basePath: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
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

function getAllTags(): VaultTagCount[] {
  const tagMap = new Map<string, number>();
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
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
function getBacklinks(targetPath: string): VaultBacklink[] {
  const targetName = path.basename(targetPath, ".md");
  const backlinks: VaultBacklink[] = [];
  function walk(dir: string, basePath: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
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
  walk(NOTEBOOK_DIR, "");
  return backlinks;
}

function getOutline(content: string): VaultOutlineHeader[] {
  const headers: VaultOutlineHeader[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) headers.push({ level: match[1].length, text: match[2].trim(), line: i + 1 });
  }
  return headers;
}

/* ======================== Holst / Canvas ======================== */

/** Имя .holst-файла: клиентское имя санитизируется до [a-zA-Z0-9_-]. */
function holstName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Список canvas-файлов (битый JSON пропускается, а не роняет список). */
function listHolsts(): VaultHolstSummary[] {
  ensureDirs();
  const items: VaultHolstSummary[] = [];
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
/** Прочитанный canvas: data === null, если JSON в файле битый. */
export interface VaultHolstRead {
  name: string;
  data: unknown;
  error?: string;
}

/** Чтение .holst по имени (без расширения). */
function readHolst(name: string): VaultHolstRead | null {
  ensureDirs();
  const safeName = holstName(name);
  const fullPath = path.join(HOLST_DIR, `${safeName}.holst`);
  if (!fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, "utf8");
  try {
    const data = JSON.parse(raw);
    return { name: safeName, data };
  } catch {
    return { name: safeName, data: null, error: "Invalid JSON" };
  }
}

/**
 * Запись .holst. Ожидает { name, data }, где data — полный снапшот tldraw.
 * meta.updatedAt всегда перезаписывается сервером: по нему строится список canvas.
 */
function writeHolst(name: string, data: Record<string, unknown>): VaultOpResult & { name: string } {
  ensureDirs();
  const safeName = holstName(name);
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
 * Удаление .holst. Здесь обычный fs.unlinkSync (а не removePath из fsUtil):
 * имя перед записью санитизируется до [a-zA-Z0-9_-], кириллицы в пути быть
 * не может — ради этого имя и приводится к ASCII.
 */
function deleteHolst(name: string): VaultOpResult {
  ensureDirs();
  const safeName = holstName(name);
  const fullPath = path.join(HOLST_DIR, `${safeName}.holst`);
  if (!fs.existsSync(fullPath)) return { ok: false, error: "Not found" };
  fs.unlinkSync(fullPath);
  logger.action("holst.delete", { name: safeName });
  return { ok: true };
}

ensureDirs();

/** Дерево заметок vault — публичная точка входа (dir фиксирован, как в .js). */
export function buildTree(): VaultTreeItem[] {
  return walkTree(NOTEBOOK_DIR);
}

export {
  readFile,
  writeFile,
  deleteFile,
  renameFile,
  createFolder,
  searchFiles,
  getAllTags,
  getBacklinks,
  getOutline,
  listHolsts,
  readHolst,
  writeHolst,
  deleteHolst,
  VAULT_DIR,
  NOTEBOOK_DIR,
  HOLST_DIR,
};
