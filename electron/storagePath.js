/**
 * Единая точка вычисления пути к папке данных приложения (storage/).
 *
 * Порядок приоритета:
 *  1. PERSONAL_APP_STORAGE — явный оверрайд (используется в dev, тестах и CI).
 *  2. Собранное приложение (app.isPackaged) — storage/ живёт в папке установки,
 *     рядом с exe: <install>\storage. Так все рабочие папки (ffmpeg, zapret,
 *     архивы, загрузки) лежат в одном месте рядом с программой и переживают
 *     обновления (NSIS заменяет только файлы из манифеста).
 *     Если папка установки не доступна на запись (например, Program Files
 *     без прав администратора) — фолбэк в %APPDATA%\PersonalApp\storage.
 *  3. Dev-режим — storage/ рядом с проектом, как раньше.
 *
 * Модуль вычисляет путь один раз при первом обращении и экспортирует
 * константы, поэтому его можно безопасно require'ить в любом порядке.
 */
const path = require("path");
const fs = require("fs");

let _electron = null;
try {
  // В чистом Node (тесты, start:server) require("electron") вернёт строку-путь —
  // игнорируем, работаем как в dev.
  const e = require("electron");
  if (e && typeof e === "object") _electron = e;
} catch { /* не в Electron-рантайме */ }

function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function resolveStorageDir() {
  // 1) Явный оверрайд (dev-скрипты, тесты, ручной запуск).
  if (process.env.PERSONAL_APP_STORAGE) return process.env.PERSONAL_APP_STORAGE;

  // 2) Упакованное приложение → storage/ в папке установки.
  if (_electron?.app?.isPackaged) {
    const installDir = path.dirname(_electron.app.getPath("exe"));
    const portable = path.join(installDir, "storage");
    if (probeWritable(portable)) return portable;
    // Фолбэк: установка в Program Files и т.п. — пишем в AppData.
    const appData = path.join(_electron.app.getPath("userData"), "storage");
    try { fs.mkdirSync(appData, { recursive: true }); } catch { /* отдаём как есть */ }
    return appData;
  }

  // 3) Dev — как раньше: storage/ рядом с проектом.
  return path.join(__dirname, "..", "storage");
}

const STORAGE_DIR = resolveStorageDir();

// Подставляем путь дочернему серверному коду ДО его require. server/config.js
// и server/ts/monitor.ts читают эту переменную — серверные модули трогать не нужно.
process.env.PERSONAL_APP_STORAGE = STORAGE_DIR;

module.exports = { STORAGE_DIR, resolveStorageDir, probeWritable };
