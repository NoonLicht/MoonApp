/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import { app, globalShortcut } from "electron";
import path from "path";
import { serverModule } from "./serverApi";
import crypto from "crypto";
import fs from "fs";
import { mlog, readSettings } from "./mainCore";
import { showWindow } from "./mainTray";
import { win } from "./main";

// --- Автозапуск при входе в систему ---
// app.setLoginItemSettings — штатный кроссплатформенный механизм Electron:
// на Windows пишет ключ в реестр Run, на Linux создаёт .desktop-файл в
// ~/.config/autostart/, на macOS — Login Item. Вызывается на старте,
// при закрытии/сворачивании окна и СРАЗУ при переключении галочки в настройках
// (renderer → appBridge.applyAutoLaunch → ipcMain "app:autolaunch"). Без последнего
// шага настройка вступала в силу только после перезапуска приложения.
export function applyAutoLaunch() {
  try {
    // В dev process.execPath — это electron.exe из node_modules: в автозагрузку он
    // попадать не должен, поэтому честно сообщаем «работает в сборке».
    if (!app.isPackaged) return { ok: false, reason: "dev", openAtLogin: false };
    const want = readSettings()?.general?.autoLaunch === true;
    const cur = app.getLoginItemSettings();
    if (cur.openAtLogin !== want) {
      app.setLoginItemSettings({ openAtLogin: want, path: process.execPath });
    }
    return { ok: true, openAtLogin: want };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e), openAtLogin: false };
  }
}

// --- Глобальный хоткей: командная палитра (Alt+Space) ---
// Показывает главное окно и просит renderer открыть оверлей-палитру поверх
// текущей страницы (см. src/components/CommandPalette.tsx) — работает даже
// если окно свёрнуто/в трее, ровно как Raycast/PowerToys Run. Настройка
// general.commandPaletteHotkey (по умолчанию включено) — выключатель в
// Settings, регистрируется/снимается заново при каждом старте.
const COMMAND_PALETTE_ACCELERATOR = "Alt+Space";

export function registerCommandPaletteHotkey() {
  try {
    globalShortcut.unregister(COMMAND_PALETTE_ACCELERATOR);
  } catch {
    /* не было зарегистрировано — не критично */
  }
  const enabled = readSettings()?.general?.commandPaletteHotkey !== false;
  if (!enabled) return;
  try {
    const ok: any = globalShortcut.register(COMMAND_PALETTE_ACCELERATOR, () => {
      showWindow();
      win?.webContents.send("app:open-palette");
    });
    if (!ok) mlog("warn", "hotkey.register_failed", { accelerator: COMMAND_PALETTE_ACCELERATOR });
  } catch (e: any) {
    mlog("error", "hotkey.register_error", { error: e?.message || String(e) });
  }
}

// --- Глобальный хоткей: собственный захват скриншота (актуально для Linux) ---
// На Windows скриншоты автосохраняются через мониторинг буфера обмена после
// системного PrintScreen/Win+Shift+S (см. startClipboardWatch ниже) — это
// работает и на Linux (Electron clipboard — кроссплатформенный API), НО там
// нет гарантии, что у пользователя вообще есть системный снипинг-инструмент,
// кладущий картинку в буфер. Поэтому на Linux дополнительно регистрируем свой
// хоткей, который сам захватывает экран через desktopCapturer и сохраняет
// результат прямо в библиотеку — без зависимости от внешнего snip-инструмента.
// На Windows эта функция не обязательна (клавиша PrintScreen уже занята
// системным шорткатом), поэтому регистрируется только на Linux.
const OWN_SCREENSHOT_ACCELERATOR = "PrintScreen";

export function registerOwnScreenshotHotkey() {
  if (process.platform !== "linux") return;
  try {
    globalShortcut.unregister(OWN_SCREENSHOT_ACCELERATOR);
  } catch {
    /* не было зарегистрировано — не критично */
  }
  const enabled = readSettings()?.screenshots?.ownHotkeyCapture !== false;
  if (!enabled) return;
  try {
    const ok = globalShortcut.register(OWN_SCREENSHOT_ACCELERATOR, () => {
      void captureOwnScreenshot();
    });
    if (!ok) {
      // На части DE PrintScreen уже занят системным снипинг-инструментом —
      // регистрация тогда просто не срабатывает; сообщаем в лог и оставляем
      // подсказку пользователю сменить комбинацию через настройки (см.
      // ownHotkeyCaptureAccelerator, если задан).
      mlog("warn", "hotkey.own_screenshot_register_failed", {
        accelerator: OWN_SCREENSHOT_ACCELERATOR,
        hint: "PrintScreen possibly reserved by desktop environment's own screenshot tool",
      });
    }
  } catch (e: any) {
    mlog("error", "hotkey.own_screenshot_register_error", { error: e?.message || String(e) });
  }
}

/** Захват всего первого экрана через desktopCapturer и сохранение в библиотеку скриншотов. */
async function captureOwnScreenshot() {
  try {
    const { desktopCapturer, screen: electronScreen } =
      require("electron") as typeof import("electron");
    const primary = electronScreen.getPrimaryDisplay();
    const scale = primary.scaleFactor || 1;
    const thumbnailSize = {
      width: Math.round(primary.size.width * scale),
      height: Math.round(primary.size.height * scale),
    };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    const source = sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      mlog("warn", "screenshot.own_capture_empty", {});
      return;
    }
    const buf = source.thumbnail.toPNG();
    const tmpPath = path.join(
      serverModule("../server/config").DIRS.tmp,
      `own-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`,
    );
    fs.writeFileSync(tmpPath, buf);
    const size = source.thumbnail.getSize();
    serverModule("../server/screenshots").saveFromTemp(tmpPath, {
      type: "image",
      ext: "png",
      mime: "image/png",
      width: size.width,
      height: size.height,
    });
    mlog("info", "screenshot.own_capture_saved", { width: size.width, height: size.height });
  } catch (e: any) {
    mlog("error", "screenshot.own_capture_failed", { error: e?.message || String(e) });
  }
}
