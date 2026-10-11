/**
 * Режим «чужой за столом»: глобальная горячая клавиша мгновенно размывает окно
 * приложения (оверлей рисует renderer, см. src/components/PrivacyShield.tsx) и
 * подменяет заголовок окна, чтобы в панели задач и переключателе окон не было
 * названий разделов и документов. Повторное нажатие возвращает всё как было.
 */
import { globalShortcut, ipcMain } from "electron";
import { mlog } from "./mainCore";
import { win } from "./main";

const ACCELERATOR = "CommandOrControl+Alt+H";
const NEUTRAL_TITLE = "Документ";

let active = false;
let savedTitle = "";

function setActive(on: boolean): void {
  if (!win || win.isDestroyed()) return;
  if (on === active) return;
  active = on;
  if (on) {
    savedTitle = win.getTitle();
    win.setTitle(NEUTRAL_TITLE);
  } else {
    win.setTitle(savedTitle || "MoonApp");
  }
}

export function registerPrivacyHotkey(): void {
  try {
    globalShortcut.unregister(ACCELERATOR);
  } catch {
    /* не было зарегистрировано */
  }
  try {
    const ok = globalShortcut.register(ACCELERATOR, () => {
      setActive(!active);
      win?.webContents.send("app:privacy", active);
    });
    if (!ok) mlog("warn", "hotkey.privacy_register_failed", { accelerator: ACCELERATOR });
  } catch (e) {
    mlog("error", "hotkey.privacy_register_error", { error: e instanceof Error ? e.message : String(e) });
  }
  // Renderer включил режим сам (кнопка/внутреннее сочетание) — синхронизируем заголовок окна.
  ipcMain.removeHandler("app:privacy-set");
  ipcMain.handle("app:privacy-set", (_e, on: unknown) => {
    setActive(on === true);
    return { ok: true, active };
  });
}
