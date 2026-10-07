/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import path from "path";
import fs from "fs";
import { app } from "electron";
import http from "http";
import { autoUpdater } from "electron-updater";
import { mlog, readSettings } from "./mainCore";
import { apiPort, apiToken, appState, win } from "./main";
import { pendingUpdateVersion, showMandatoryUpdate } from "./mainUpdates";

// --- Трей ---
let tray: any = null;

// Иконка трея: сначала пробуем настоящий .ico-файл (build/icon.ico). Раньше
// иконка бралась только из exe через app.getFileIcon(..., { size: "normal" }) —
// на frameless/transparent-окне она часто приходила пустой/битой, и трей
// показывал пустой квадрат. Файловый .ico ресайзим под системный размер трея.
let trayIconCache: any = null;

function trayIconCandidates() {
  const list = [];
  // packaged: icon.ico кладётся в resources/ (build.extraResources в package.json).
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, "icon.ico"));
  // dev: build/icon.ico рядом с проектом.
  list.push(path.join(__dirname, "..", "build", "icon.ico"));
  return list;
}

async function makeTrayIcon() {
  const { nativeImage } = require("electron") as typeof import("electron");
  if (trayIconCache) return trayIconCache;
  for (const p of trayIconCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (img && !img.isEmpty()) {
        trayIconCache = img.resize({ width: 16, height: 16 });
        return trayIconCache;
      }
    } catch {
      /* пробуем следующий источник */
    }
  }
  // Фолбэк: иконка самого exe (Windows умеет извлекать её нативно).
  try {
    const icon = await app.getFileIcon(process.execPath, { size: "small" });
    if (icon && !icon.isEmpty()) {
      trayIconCache = icon;
      return trayIconCache;
    }
  } catch {
    /* ниже — пустая картинка */
  }
  return nativeImage.createEmpty();
}

export async function ensureTray() {
  if (tray) return tray;
  const { Tray, Menu } = require("electron") as typeof import("electron");
  tray = new Tray(await makeTrayIcon());
  tray.setToolTip("MoonApp");
  tray.setContextMenu(Menu.buildFromTemplate(await trayTemplate()));
  // Левый клик и двойной клик по иконке — показать окно.
  tray.on("click", () => showWindow());
  tray.on("double-click", () => showWindow());
  mlog("action", "tray.create", {});
  return tray;
}

function zapretApi(urlPath: any, body?: any) {
  return new Promise<any>((resolve) => {
    if (!apiPort) return resolve(null);
    const payload = body ? JSON.stringify(body) : null;
    const req: any = http.request(
      {
        host: "127.0.0.1",
        port: apiPort,
        path: `/api/zapret${urlPath}`,
        method: payload ? "POST" : "GET",
        headers: {
          "x-moonapp-token": apiToken || "",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: 8000,
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => {
          raw += d;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Перестроить меню трея (после переключения стратегии / старта/стопа). */
export async function refreshTray() {
  const { Menu } = require("electron") as typeof import("electron");
  try {
    if (tray) tray.setContextMenu(Menu.buildFromTemplate(await trayTemplate()));
  } catch {
    /* окно уже уничтожено */
  }
}

async function trayTemplate() {
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Открыть", click: () => showWindow() },
    {
      label: "Проверить обновления",
      visible: !!app.isPackaged,
      click: () => {
        void autoUpdater.checkForUpdates().catch(() => {});
      },
    },
    { type: "separator" },
  ];
  // Подменю «Обход блокировок»: статус + конфиги по группам + Стоп + обновление.
  const [strategies, status, update] = await Promise.all([
    zapretApi("/strategies"),
    zapretApi("/status"),
    zapretApi("/update"),
  ]);
  if (Array.isArray(strategies) && strategies.length) {
    const active = status?.active;
    const current = status?.strategy || null;
    const version = status?.engine?.version || status?.version || null;
    const groups = [
      ["base", "Базовый"],
      ["alt", "ALT"],
      ["fake-tls-auto", "FAKE TLS AUTO"],
      ["simple-fake", "SIMPLE FAKE"],
      ["exp", "EXP"],
    ];
    const strategyItem = (s: any) => ({
      label: s.name,
      type: "checkbox",
      checked: !!active && current === s.id,
      click: () => {
        void zapretApi("/start", {
          strategyId: s.id,
          mode: readSettings()?.zapret?.mode === "process" ? "process" : "service",
        }).then(() => refreshTray());
      },
    });
    const grouped = groups
      .map(([g, title]) => {
        const list = strategies.filter((s) => s.group === g);
        return list.length
          ? { label: `${title} (${list.length})`, submenu: list.map(strategyItem) }
          : null;
      })
      .filter(Boolean);
    const ungrouped = strategies.filter((s) => !groups.some(([g]) => g === s.group));
    const subItems: any[] = [
      { label: active ? `● Активно: ${current || "—"}` : "○ Остановлено", enabled: false },
      { label: `Версия: ${version || "не установлена"}`, enabled: false },
      { type: "separator" },
      ...(ungrouped.length ? [...ungrouped.map(strategyItem)] : []),
      ...grouped,
      { type: "separator" },
      {
        label: "Остановить обход",
        enabled: !!active,
        click: () => {
          void zapretApi("/stop").then(() => refreshTray());
        },
      },
    ];
    // Обновление движка прямо из трея (прогресс виден на странице Bypass).
    if (update && !update.error) {
      const has = !!update.hasUpdate;
      subItems.push({
        label: has
          ? `⬇ Обновить zapret до ${update.latest}`
          : `⬇ Переустановить zapret ${update.installed || ""}`,
        click: () => {
          void zapretApi("/install", { tag: has ? update.latest : undefined }).then(() =>
            refreshTray(),
          );
        },
      });
    }
    items.push({ label: "Обход блокировок (zapret)", submenu: subItems });
  }
  items.push(
    { type: "separator" },
    {
      label: "Выход",
      click: () => {
        appState.quitting = true;
        app.quit();
      },
    },
  );
  return items;
}

export function showWindow() {
  if (!win) return;
  try {
    // Окно могло остаться в состоянии minimized после hide() — без restore()
    // show() не возвращает его к жизни, и клик выглядит «зависшим».
    if (win.isMinimized()) win.restore();
    win.setSkipTaskbar(false);
    win.show();
    win.focus();
    // Прозрачное frameless-окно после hide/show иногда не перерисовывается —
    // просим Chromium отрисовать кадр заново.
    try {
      win.webContents.invalidate?.();
    } catch {
      /* не критично */
    }
    mlog("action", "win.show", {});
  } catch (e: any) {
    mlog("error", "win.show_failed", { error: e?.message || String(e) });
  }
  // Обновление скачано и ждёт установки — обязательный диалог возвращаем на экран:
  // окно могло быть спрятано в трей, а пользователь мог закрыть диалог вместе с ним.
  if (pendingUpdateVersion)
    setTimeout(() => {
      void showMandatoryUpdate();
    }, 400);
  try {
    tray?.destroy();
  } catch {
    /* уже уничтожен */
  }
  tray = null;
}
