/**
 * Единая точка вычисления пути к папке данных приложения (storage/).
 *
 * Порядок приоритета:
 *  1. Собранное приложение (app.isPackaged) — storage/ ВСЕГДА в папке установки,
 *     рядом с exe: <install>\storage. Переменная окружения здесь игнорируется
 *     намеренно: иначе запущенная копия подхватывала бы данные и настройки
 *     другого места (например, папки с исходниками), что уже приводило к
 *     «переезду» настроек между сборками.
 *     Если папка установки не доступна на запись (например, Program Files
 *     без прав администратора) — фолбэк в %APPDATA%\MoonApp\storage.
 *  2. MOONAPP_STORAGE — явный оверрайд, только для dev/тестов/CI.
 *  3. Dev-режим — storage/ рядом с проектом.
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
} catch {
  /* не в Electron-рантайме */
}

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
  // 1) Упакованное приложение → только storage/ в папке установки.
  //    Оверрайд из окружения здесь не применяется (см. комментарий выше).
  if (_electron?.app?.isPackaged) {
    const installDir = path.dirname(_electron.app.getPath("exe"));
    const portable = path.join(installDir, "storage");
    if (probeWritable(portable)) return portable;
    // Фолбэк: установка в Program Files и т.п. — пишем в AppData.
    const appData = path.join(_electron.app.getPath("userData"), "storage");
    try {
      fs.mkdirSync(appData, { recursive: true });
    } catch {
      /* отдаём как есть */
    }
    return appData;
  }

  // 2) Явный оверрайд (dev-скрипты, тесты, ручной запуск сервера).
  if (process.env.MOONAPP_STORAGE) return process.env.MOONAPP_STORAGE;

  // 3) Dev — storage/ рядом с проектом.
  return path.join(__dirname, "..", "storage");
}

const STORAGE_DIR = resolveStorageDir();

// Подставляем путь дочернему серверному коду ДО его require. server/config.js
// и server/ts/monitor.ts читают эту переменную — серверные модули трогать не нужно.
process.env.MOONAPP_STORAGE = STORAGE_DIR;

module.exports = { STORAGE_DIR, resolveStorageDir, probeWritable };
