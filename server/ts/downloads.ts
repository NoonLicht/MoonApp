/**
 * Загрузка файлов для страницы «Магазин»: политика поверх общего
 * server/ts/download.ts — каталог назначения из настроек, проверка схемы,
 * лимит размера и запуск скачанного установщика.
 *
 * TS-исходник, как server/ts/download.ts: компилируется в server/downloads.js
 * командой `npm run compile:server`, поэтому `require("./downloads")` из
 * обычных .js-модулей продолжает работать без изменений.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import config from "./config";
import logger from "./logger";
import settings from "./settings";
import { downloadToFile, mb } from "./download";

const { DIRS } = config;

/**
 * Каталог загрузок: пользовательская папка из настроек (store.downloadDir)
 * или дефолтная storage/downloads, если путь не задан/невалиден.
 */
export function resolveDestDir(): string {
  try {
    const custom = String(settings.get("store").downloadDir || "").trim();
    if (custom) {
      fs.mkdirSync(custom, { recursive: true });
      return custom;
    }
  } catch {
    /* чтение настроек не должно ломать загрузку */
  }
  fs.mkdirSync(DIRS.downloads, { recursive: true });
  return DIRS.downloads;
}

/** .bat/.cmd убрал специально — запуск скачанного скрипта это удалённое выполнение кода. */
export const ALLOWED_EXT = [".exe", ".msi", ".msix", ".appx", ".zip"];

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 ГБ, чтоб диск не забили
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на одну загрузку

/** Имя файла из адреса: базовая часть пути, безопасные символы, фолбэк download.bin. */
export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    let base = path.basename(u.pathname);
    if (!base || base === "/") base = "download.bin";
    return decodeURIComponent(base).replace(/[^\w.-]+/g, "_");
  } catch {
    return "download.bin";
  }
}

/** Результат загрузки: путь на диске, имя файла и число записанных байт. */
export interface DownloadResult {
  file: string;
  name: string;
  size: number;
}

/**
 * Файл по url качается в каталог загрузок (настройки store.downloadDir или
 * storage/downloads) → { file, name, size }.
 *
 * Сам цикл загрузки живёт в общем server/ts/download.ts: он одинаков для store,
 * установщиков движков и моделей. Здесь остаётся только политика store —
 * проверка схемы, каталог назначения, лимит 2 ГБ и тексты ошибок для UI.
 */
export async function download(
  url: string,
  destDir: string = resolveDestDir(),
): Promise<DownloadResult> {
  const href = String(url).trim();
  if (!/^https?:\/\//i.test(href)) throw new Error("Допускаются только http/https ссылки");

  // Имя зависит от адреса ПОСЛЕ редиректов (GitHub уводит релиз на
  // objects.githubusercontent.com), поэтому путь считается внутри resolveDest.
  let name = fileNameFromUrl(href);
  const size = await downloadToFile(href, path.join(destDir, name), {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    headers: { Accept: "*/*", Referer: new URL(href).origin + "/" },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxBytes: MAX_DOWNLOAD_BYTES,
    resolveDest: (finalUrl: string) => {
      name = fileNameFromUrl(finalUrl);
      return path.join(destDir, name);
    },
    httpErrorText: (status: number) => `HTTP ${status} при скачивании ${href}`,
    tooLargeText: (bytes: number, max: number) =>
      `Файл слишком большой (${mb(bytes)} MB), лимит ${mb(max)} MB`,
  });

  const file = path.join(destDir, name);
  logger.info("download.ok", { name, size });
  return { file, name, size };
}

/** Запуск установщика: окно мастера показывается пользователю (НЕ тихо). */
export function runInstaller(absPath: string): { launched: true; cmd: string } {
  const ext = path.extname(absPath).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new Error(`Неподдерживаемый тип файла: ${ext}`);

  let cmd: string;
  let args: string[];
  if (ext === ".msi" || ext === ".msix") {
    cmd = "msiexec";
    args = ["/i", absPath];
  } else if (ext === ".appx") {
    cmd = "powershell";
    args = ["-NoProfile", "-Command", `Add-AppxPackage -Path "${absPath}"`];
  } else {
    cmd = absPath; // .exe и т.п. — просто запускаем (вылезет окно мастера)
    args = [];
  }

  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  logger.info("install.launched", { cmd, args });
  return { launched: true, cmd };
}
