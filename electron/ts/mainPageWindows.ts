/**
 * Отдельные окна страниц: открыть любую страницу приложения в своём окне на
 * выбранном мониторе (презентация на втором экране, лекция рядом с заметками).
 *
 * Окна обычные, с системной рамкой: у основного окна рамка рисуется самим
 * интерфейсом и управляется из главного процесса, а дополнительным этого не нужно.
 * Загружается тот же локальный сервер, страница задаётся параметром ?solo=<id>.
 */
import { BrowserWindow, ipcMain, screen, nativeTheme } from "electron";
import path from "path";

const PAGE_ID = /^[a-z0-9_-]{1,32}$/i;
const extra = new Set<BrowserWindow>();

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export function listDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    primary: d.id === primary,
    bounds: d.bounds,
  }));
}

/** Принадлежит ли sender одному из дополнительных окон (для выдачи токена). */
export function isPageWindowSender(sender: unknown): boolean {
  for (const w of extra) if (!w.isDestroyed() && w.webContents === sender) return true;
  return false;
}

export function registerPageWindows(port: number): void {
  ipcMain.removeHandler("win:list-displays");
  ipcMain.handle("win:list-displays", () => listDisplays());

  ipcMain.removeHandler("win:open-page");
  ipcMain.handle("win:open-page", (_e, pageId: unknown, displayId?: unknown, opts?: unknown) => {
    const id = String(pageId ?? "");
    if (!PAGE_ID.test(id)) return { ok: false, error: "bad_page" };
    const displays = screen.getAllDisplays();
    const target =
      displays.find((d) => d.id === Number(displayId)) ?? screen.getPrimaryDisplay();
    const b = target.workArea;
    // Виджет: небольшое окно поверх остальных в правом нижнем углу экрана.
    const widget = !!(opts && typeof opts === "object" && (opts as { widget?: unknown }).widget === true);
    const size = widget
      ? { width: 380, height: 520 }
      : { width: Math.round(b.width * 0.9), height: Math.round(b.height * 0.9) };
    const pos = widget
      ? { x: b.x + b.width - size.width - 16, y: b.y + b.height - size.height - 16 }
      : { x: b.x + Math.round(b.width * 0.05), y: b.y + Math.round(b.height * 0.05) };
    const win = new BrowserWindow({
      ...pos,
      ...size,
      minWidth: widget ? 280 : 720,
      minHeight: widget ? 200 : 520,
      alwaysOnTop: widget,
      skipTaskbar: widget,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0e16" : "#eef0f6",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    extra.add(win);
    win.on("closed", () => extra.delete(win));
    void win.loadURL(`http://127.0.0.1:${port}/?solo=${encodeURIComponent(id)}`);
    return { ok: true };
  });
}

export function closePageWindows(): void {
  for (const w of extra) if (!w.isDestroyed()) w.close();
  extra.clear();
}
