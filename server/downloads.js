const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { DIRS } = require("./config");
const logger = require("./logger");
const settings = require("./settings");

// Каталог загрузок: пользовательская папка из настроек (store.downloadDir)
// или дефолтная storage/downloads, если путь не задан/невалиден.
function resolveDestDir() {
  try {
    const custom = String(settings.get("store").downloadDir || "").trim();
    if (custom) {
      fs.mkdirSync(custom, { recursive: true });
      return custom;
    }
  } catch { /* чтение настроек не должно ломать загрузку */ }
  fs.mkdirSync(DIRS.downloads, { recursive: true });
  return DIRS.downloads;
}

// .bat/.cmd убрал специально — запуск скачанного скрипта это удалённое выполнение кода.
const ALLOWED_EXT = [".exe", ".msi", ".msix", ".appx", ".zip"];
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 ГБ, чтоб диск не забили
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;        // 10 минут на одну загрузку

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    let base = path.basename(u.pathname);
    if (!base || base === "/") base = "download.bin";
    return decodeURIComponent(base).replace(/[^\w.\-]+/g, "_");
  } catch {
    return "download.bin";
  }
}

// Файл по url качается в каталог загрузок (настройки store.downloadDir или
// storage/downloads) → { file, name, size }.
async function download(url, destDir = resolveDestDir()) {
  const href = String(url).trim();
  if (!/^https?:\/\//i.test(href)) throw new Error("Допускаются только http/https ссылки");

  const res = await fetch(href, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "*/*",
      Referer: new URL(href).origin + "/",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании ${href}`);

  const name = fileNameFromUrl(res.url || href);
  const file = path.join(destDir, name);

  // Content-Length сверяется ещё до записи в файл.
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Файл слишком большой (${Math.round(declared / 1024 ** 2)} MB), лимит ${MAX_DOWNLOAD_BYTES / 1024 ** 2} MB`);
  }

  let received = 0;
  const ws = fs.createWriteStream(file);
  let tooBig = false;
  // res.body у fetch — это веб-ReadableStream, у него нет .on/.pipe, поэтому for-await.
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        tooBig = true;
        throw new Error("limit-exceeded"); // поток прерывается; очистка файла — ниже
      }
      if (!ws.write(buf)) await new Promise((r) => ws.once("drain", r));
    }
  } catch (e) {
    // Частично скачанный файл удаляется.
    try { ws.destroy(); fs.rmSync(file, { force: true }); } catch {}
    if (tooBig) throw new Error(`Загрузка прервана: превышен лимит ${MAX_DOWNLOAD_BYTES / 1024 ** 2} MB`);
    if (e.message === "limit-exceeded") throw new Error(`Загрузка прервана: превышен лимит ${MAX_DOWNLOAD_BYTES / 1024 ** 2} MB`);
    throw e;
  }
  await new Promise((resolve, reject) => {
    ws.end((err) => (err ? reject(err) : resolve()));
  });

  const size = fs.statSync(file).size;
  logger.info("download.ok", { name, size });
  return { file, name, size };
}

// Установщик запускается с окном мастера (НЕ тихо).
function runInstaller(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new Error(`Неподдерживаемый тип файла: ${ext}`);

  let cmd;
  let args = [];
  if (ext === ".msi" || ext === ".msix") {
    cmd = "msiexec";
    args = [ext === ".msi" ? "/i" : "/i", absPath];
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

module.exports = { download, runInstaller, fileNameFromUrl, ALLOWED_EXT };