/**
 * Действия из контекстного меню Проводника (см. server/ts/contextMenu.ts):
 * приложение запускается (или получает second-instance) с аргументами
 * `--moonapp-action=<действие> <путь>`; здесь они выполняются без участия окна.
 */
import { Notification } from "electron";
import { serverModule } from "./serverApi";
import { mlog } from "./mainCore";

export function handleMenuArgv(argv: string[]): boolean {
  try {
    const cm = serverModule("../server/contextMenu");
    const parsed = cm.parseArgv(argv);
    if (!parsed) return false;
    const r = cm.runAction(parsed.action, parsed.target);
    mlog("info", "contextmenu.action", { action: r.action });
    if (Notification.isSupported()) {
      new Notification({
        title: "MoonApp",
        body: r.action === "folder-snapshot" ? "OK" : `OK: ${r.result}`,
      }).show();
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mlog("error", "contextmenu.failed", { error: msg });
    if (Notification.isSupported()) {
      new Notification({ title: "MoonApp", body: msg }).show();
    }
    return true;
  }
}
