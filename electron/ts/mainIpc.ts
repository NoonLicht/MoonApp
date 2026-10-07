/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import { ipcMain } from "electron";
import path from "path";
import { STORAGE_DIR } from "./storagePath";
import {
  applyAutoLaunch,
  registerCommandPaletteHotkey,
  registerOwnScreenshotHotkey,
} from "./mainHotkeys";
import { mlog } from "./mainCore";
import { refreshTray } from "./mainTray";

// Открыть папку, в которой лежат данные приложения (storage). Кнопка в верхней
// панели: раньше она открывала каталог установки, что путало — после переезда
// данных в %APPDATA% пользователь искал настройки/паки именно там.
// Открываем РОДИТЕЛЯ storage: в собранной версии это %APPDATA%\MoonApp
// (userData, где лежат storage/, куки Chromium и служебные файлы), в dev —
// корень проекта.
ipcMain.handle("app:autolaunch", () => applyAutoLaunch());
// Настройка general.commandPaletteHotkey меняется через обычный API настроек
// (settings.json), поэтому main-процессу нужно просто перечитать её и
// перерегистрировать/снять хоткей — вызывается со страницы настроек сразу
// после сохранения, без перезапуска приложения.
ipcMain.handle("app:refresh-hotkey", () => {
  registerCommandPaletteHotkey();
  registerOwnScreenshotHotkey();
  return { ok: true };
});

// Выбрать файл через нативный диалог проводника — используется кнопкой
// "Обзор..." (страница Автоматизация: путь к программе/скрипту, и другие
// поля выбора локального файла).
ipcMain.handle("dialog:pick-file", async (_e, opts) => {
  try {
    const { dialog } = require("electron") as typeof import("electron");
    const filters = Array.isArray(opts?.filters) ? opts.filters : undefined;
    const res = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters,
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Выбрать папку через нативный диалог проводника — используется кнопкой
// "Обзор..." у полей путей к папкам (например, папка сохранений игры).
ipcMain.handle("dialog:pick-folder", async () => {
  try {
    const { dialog } = require("electron") as typeof import("electron");
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Открыть внешнюю ссылку (http/https) в системном браузере по умолчанию —
// используется кликабельными ссылками в заметках/закладках.
ipcMain.handle("shell:open-external", (_e, url) => {
  try {
    const { shell } = require("electron") as typeof import("electron");
    const u = String(url || "");
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: "unsupported protocol" };
    void shell.openExternal(u);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("shell:open-app-dir", () => {
  try {
    const { shell } = require("electron") as typeof import("electron");
    const dir = path.dirname(STORAGE_DIR);
    void shell.openPath(dir);
    mlog("action", "shell.open_app_dir", { dir, storage: STORAGE_DIR });
    return { ok: true, dir, storageDir: STORAGE_DIR };
  } catch (e: any) {
    mlog("error", "shell.open_app_dir_failed", { error: e?.message || String(e) });
    return { ok: false, error: e?.message || String(e) };
  }
});

// Reveal in File Explorer: выделить файл/папку в проводнике (контекстные меню
// страниц видео/архива вызывают через appBridge.revealPath).
ipcMain.handle("shell:reveal", (_e, p) => {
  try {
    const { shell } = require("electron") as typeof import("electron");
    const full = String(p || "");
    if (!path.isAbsolute(full)) return false;
    shell.showItemInFolder(full);
    return true;
  } catch {
    return false;
  }
});

// Обновить подменю zapret в трее: страница Bypass Control вызывает после
// изменения стратегий/профилей, чтобы быстрые переключения были актуальны.
ipcMain.on("bypass:tray-refresh", () => {
  void refreshTray();
});
