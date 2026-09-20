"use strict";

/**
 * Каталог моделей для скриптов (fetch-models.js, verify-model.js).
 *
 * Приоритет тот же, что у сервера (server/upscale.js → loadManifest): скачанный
 * манифест из storage важнее вшитого в репозиторий — так скрипт видит каталог,
 * который пользователь получил кнопкой «Обновить каталог» в приложении.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** Каталог storage: тот же резолвер, что у server/config.js. */
function storageDir() {
  if (process.env.MOONAPP_STORAGE) return process.env.MOONAPP_STORAGE;
  try {
    return require(path.join(ROOT, "server", "config")).DIRS.storage;
  } catch {
    // config.js не собран / нет Electron-окружения — dev-фолбэк, как у config.
    return path.join(ROOT, "storage");
  }
}

/** Вшитый в репозиторий каталог (первый запуск, офлайн). */
function bundledManifestFile() {
  return path.join(ROOT, "server", "models.manifest.json");
}

/** Скачанный каталог (кнопка «Обновить каталог»): важнее вшитого. */
function userManifestFile() {
  return path.join(storageDir(), "models", "models.manifest.json");
}

/** Файл, из которого реально читается каталог. */
function manifestFile() {
  const user = userManifestFile();
  return fs.existsSync(user) ? user : bundledManifestFile();
}

/** Манифест целиком: { file, doc, models }. */
function readManifest() {
  const file = manifestFile();
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, doc, models: Array.isArray(doc.models) ? doc.models : [] };
}

module.exports = {
  ROOT,
  storageDir,
  bundledManifestFile,
  userManifestFile,
  manifestFile,
  readManifest,
};
