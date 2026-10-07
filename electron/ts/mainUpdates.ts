/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import { autoUpdater } from "electron-updater";
import { app, ipcMain } from "electron";
import { mlog } from "./mainCore";
import { appState, win } from "./main";
import { showWindow } from "./mainTray";

// --- Обновления приложения (только в packaged-сборке) ---
// Источник — GitHub Releases (build.publish в package.json).
//
// С 0.2.2 обновления ОБЯЗАТЕЛЬНЫ:
//   1) проверка запускается при каждом старте (и каждые 4 часа, пока приложение
//      открыто) — выключателя в интерфейсе больше нет, general.autoUpdate в
//      settings.json приводится к true миграцией (server/settings.js);
//   2) новая версия скачивается сразу (autoDownload), в фоне, без вопросов;
//   3) когда установщик скачан, показываем диалог, который НЕЛЬЗЯ закрыть, не
//      обновившись (showMandatoryUpdate): кнопка одна, а «крестик» и Esc ведут
//      ровно к тому же — установке и перезапуску.
// Зачем: пропущенная версия = старая сборка у пользователя, а вместе с ней
// несовместимые настройки и протоколы. Установщик NSIS обновляет только файлы
// программы: папка storage (настройки, БД, записи лекций, загрузки) не трогается.
//
// Если скачать не удалось (нет сети, CDN недоступен) — приложение НЕ блокируем:
// иначе пользователь остался бы без работающей программы. Проверка повторится по
// таймеру и при следующем запуске. В dev-режиме обновлений нет (updatable=false).
let updateTimer: any = null;
let updaterReady = false;
/** Версия скачанного, но ещё не установленного обновления (null — обновления нет). */
export let pendingUpdateVersion: any = null;
/** Обязательный диалог уже открыт: повторные события не должны открывать второй. */
let mandatoryDialogOpen = false;

function scheduleUpdateTimer() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (!updaterReady) return;
  // Повторная проверка каждые 4 часа, пока приложение открыто.
  updateTimer = setInterval(
    () => {
      // Если обновление уже скачано, но диалог почему-то закрылся — показываем снова.
      if (pendingUpdateVersion) {
        void showMandatoryUpdate();
        return;
      }
      void autoUpdater.checkForUpdates().catch(() => {});
    },
    4 * 60 * 60 * 1000,
  );
}

/** Установить скачанное обновление и перезапустить приложение. */
function installUpdate() {
  if (!pendingUpdateVersion) return;
  mlog("action", "updater.install", { version: pendingUpdateVersion });
  appState.quitting = true;
  try {
    autoUpdater.quitAndInstall();
  } catch (e: any) {
    mlog("error", "updater.install_failed", { error: e?.message || String(e) });
  }
}

/**
 * Обязательный диалог установки. Кнопка одна, и cancelId указывает на неё же:
 * «закрыть в никуда» нельзя — любое действие (кнопка, крестик, Esc) ведёт к
 * установке. Диалог модален к главному окну: пока он открыт, окно не принимает
 * ввод, поэтому «свернуть и забыть» не получится.
 */
export async function showMandatoryUpdate() {
  if (!pendingUpdateVersion || mandatoryDialogOpen) return;
  const { dialog, Notification } = require("electron") as typeof import("electron");
  mandatoryDialogOpen = true;
  const version = pendingUpdateVersion;
  // Системное уведомление — на случай, если окно спрятано в трей: клик по нему
  // поднимает окно, а showWindow() вернёт диалог на экран.
  try {
    const n = new Notification({
      title: "MoonApp",
      body: `Обновление ${version} скачано — приложение перезапустится для установки`,
    });
    n.on("click", () => showWindow());
    n.show();
  } catch {
    /* уведомления могут быть недоступны */
  }
  try {
    await dialog.showMessageBox(win && !win.isDestroyed() ? win : null, {
      type: "info",
      title: "MoonApp — обновление",
      message: `Скачано обновление ${version}`,
      detail:
        "Приложение будет перезапущено и установит новую версию. Отказаться " +
        "нельзя: это окно закрывается только установкой. Данные (папка storage) " +
        "не затрагиваются.",
      buttons: ["Перезапустить и установить"],
      defaultId: 0,
      cancelId: 0, // та же кнопка: крестик и Esc приводят к установке
      noLink: true,
    });
  } catch (e: any) {
    mlog("error", "updater.dialog_failed", { error: e?.message || String(e) });
  } finally {
    mandatoryDialogOpen = false;
  }
  installUpdate();
}

export function setupAutoUpdates() {
  if (!app.isPackaged) return;
  try {
    autoUpdater.logger = console;
    // Скачиваем сразу: отдельного разрешения на скачивание не спрашиваем — обновление
    // обязательно, пользователь лишь увидит готовый к установке файл.
    autoUpdater.autoDownload = true;
    // Если приложение закрыли (или система завершила процесс), установщик всё равно
    // применится — иначе скачанное обновление зависло бы «в никуда».
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", (info) => {
      mlog("info", "updater.available", { version: info?.version || null });
    });
    autoUpdater.on("update-not-available", () => {
      mlog("info", "updater.up_to_date", {});
    });
    autoUpdater.on("update-downloaded", (info) => {
      pendingUpdateVersion = info?.version || "";
      mlog("info", "updater.downloaded", { version: pendingUpdateVersion, mandatory: true });
      void showMandatoryUpdate();
    });
    autoUpdater.on("error", (err) => {
      mlog("error", "updater.error", { error: err?.message || String(err) });
      console.error("[updater]", err?.message || err);
    });
    updaterReady = true;
    mlog("info", "updater.check", { trigger: "startup" });
    void autoUpdater.checkForUpdates().catch(() => {
      /* нет сети — повторим по таймеру */
    });
    scheduleUpdateTimer();
  } catch (e) {
    console.error("[updater] init failed:", e);
  }
}

// Ручная проверка (кнопка/пункт меню): возвращает версию апдейта или null.
ipcMain.handle("updates:check", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev" };
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r?.updateInfo?.version || null;
    const isUpdate = !!v && v !== app.getVersion();
    return { ok: true, available: isUpdate, version: isUpdate ? v : null };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "error" };
  }
});

// Выключателя автообновления больше нет: обновления обязательны (0.2.2), поэтому
// канал «updates:toggle» удалён вместе с кнопкой в Настройках. general.autoUpdate
// в settings.json остаётся для совместимости и всегда true (см. server/settings.js).

// Ручное скачивание обновления (кнопка в Настройках): проверка → downloadUpdate.
// По завершении сработает «update-downloaded» → обязательный диалог установки.
ipcMain.handle("updates:download", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev" };
  // Обновление уже скачано — просто показываем обязательный диалог.
  if (pendingUpdateVersion) {
    void showMandatoryUpdate();
    return { ok: true, available: true, version: pendingUpdateVersion, downloading: false };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r?.updateInfo?.version || null;
    const isUpdate = !!v && v !== app.getVersion();
    if (!isUpdate) return { ok: true, available: false, version: null };
    void autoUpdater.downloadUpdate().catch((e) => console.error("[updater]", e?.message || e));
    return { ok: true, available: true, version: v, downloading: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "error" };
  }
});
