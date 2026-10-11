/**
 * Версии папок: полный снимок папки в хранилище приложения и восстановление
 * из него. Восстановление никогда не перезаписывает исходную папку — версия
 * раскладывается рядом в «<имя> (версия <метка>)».
 *
 * Все функции принимают корень хранилища `root`, поэтому тестируются на
 * временных каталогах. Служебные каталоги (node_modules, .git) пропускаются,
 * общий размер снимка ограничен MAX_BYTES.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const MAX_BYTES = 500 * 1024 * 1024;
export const MAX_VERSIONS = 10;
const SKIP = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information"]);

export interface FolderVersion {
  id: string;
  at: number;
  files: number;
  bytes: number;
  label: string;
}

const keyOf = (folder: string): string =>
  crypto.createHash("sha1").update(path.resolve(folder).toLowerCase()).digest("hex").slice(0, 16);

const dirFor = (root: string, folder: string): string => path.join(root, keyOf(folder));

/** Размер и число файлов; бросает folder_too_large при превышении лимита. */
function measure(dir: string, acc = { files: 0, bytes: 0 }): { files: number; bytes: number } {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) measure(p, acc);
    else if (e.isFile()) {
      acc.files++;
      acc.bytes += fs.statSync(p).size;
      if (acc.bytes > MAX_BYTES) throw new Error("folder_too_large");
    }
  }
  return acc;
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else if (e.isFile()) fs.copyFileSync(src, dst);
  }
}

export function snapshotFolder(
  root: string,
  folder: string,
  opts: { label?: string; now?: number } = {},
): FolderVersion {
  const src = path.resolve(folder);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error("not_a_folder");
  // нельзя снимать само хранилище версий или его родителя (рекурсия)
  const rel = path.relative(src, path.resolve(root));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("folder_contains_storage");
  const size = measure(src);
  const at = opts.now ?? Date.now();
  const base = dirFor(root, src);
  let id = String(at);
  while (fs.existsSync(path.join(base, id))) id = String(Number(id) + 1);
  copyDir(src, path.join(base, id, "data"));
  const meta: FolderVersion = {
    id,
    at: Number(id),
    files: size.files,
    bytes: size.bytes,
    label: String(opts.label ?? "").slice(0, 80),
  };
  fs.writeFileSync(path.join(base, id, "meta.json"), JSON.stringify(meta), "utf8");
  fs.writeFileSync(path.join(base, "folder.txt"), src, "utf8");
  // оставляем MAX_VERSIONS последних
  const all = listVersions(root, src);
  for (const old of all.slice(MAX_VERSIONS)) fs.rmSync(path.join(base, old.id), { recursive: true, force: true });
  return meta;
}

/** Версии папки, новые первыми. */
export function listVersions(root: string, folder: string): FolderVersion[] {
  const base = dirFor(root, folder);
  if (!fs.existsSync(base)) return [];
  const out: FolderVersion[] = [];
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(base, e.name, "meta.json"), "utf8")));
    } catch {
      /* повреждённая версия пропускается */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Раскладывает версию рядом с исходной папкой; возвращает путь результата. */
export function restoreVersion(root: string, folder: string, id: string): string {
  if (!/^\d+$/.test(id)) throw new Error("bad_id");
  const src = path.resolve(folder);
  const data = path.join(dirFor(root, src), id, "data");
  if (!fs.existsSync(data)) throw new Error("version_not_found");
  const stamp = new Date(Number(id)).toISOString().slice(0, 19).replace(/[T:]/g, "-");
  let dest = `${src} (версия ${stamp})`;
  for (let n = 2; fs.existsSync(dest); n++) dest = `${src} (версия ${stamp}) ${n}`;
  copyDir(data, dest);
  return dest;
}

export function deleteVersion(root: string, folder: string, id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  const dir = path.join(dirFor(root, folder), id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
