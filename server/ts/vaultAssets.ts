/**
 * Картинки, вставленные в заметки My Space (кнопка "Вложить" в тулбаре,
 * вставка из файла или буфера обмена): файл сохраняется в
 * storage/vault/assets/<id>.<ext>, вставка в markdown ссылается на
 * /api/myspace-vault/assets/:id — так вставленная картинка переживает
 * переименование/перенос файла заметки и не хранит абсолютный путь диска.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "./config";

const { DIRS } = config;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

export interface SavedAsset {
  id: string;
  ext: string;
}

/** Сохраняет буфер картинки под новым id, расширение — по исходному имени/mime. */
export function saveAsset(buffer: Buffer, originalName: string, mime?: string): SavedAsset {
  let ext = path.extname(originalName || "").toLowerCase();
  if (!ext || !MIME_BY_EXT[ext]) {
    const fromMime = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime);
    ext = fromMime ? fromMime[0] : ".png";
  }
  const id = crypto.randomBytes(10).toString("hex");
  const filePath = path.join(DIRS.vaultAssets, `${id}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { id, ext };
}

/** Находит файл по id (расширение неизвестно заранее — ищем среди допустимых). */
export function findAsset(id: string): { path: string; mime: string } | null {
  if (!/^[a-f0-9]{20}$/.test(id)) return null;
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const p = path.join(DIRS.vaultAssets, `${id}${ext}`);
    if (fs.existsSync(p)) return { path: p, mime: MIME_BY_EXT[ext] };
  }
  return null;
}

export { MIME_BY_EXT };
