const { app, BrowserWindow, safeStorage, ipcMain } = require("electron");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { startServer } = require("../server");

// Аппаратное ускорение Chromium. По умолчанию вкл.; если в настройках
// performance.hardwareAcceleration=false — выключается ДО создания окна, иначе не подхватится.
function applyHardwareAcceleration() {
  try {
    const storage =
      process.env.PERSONAL_APP_STORAGE || path.join(__dirname, "..", "storage");
    const raw = JSON.parse(fs.readFileSync(path.join(storage, "settings.json"), "utf8"));
    if (raw?.performance?.hardwareAcceleration === false) {
      app.disableHardwareAcceleration();
    }
  } catch {
    // Настроек нет — остаётся дефолт.
  }
}
applyHardwareAcceleration();

function findFreePort(start = 4000, maxTry = 100) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryListen = (p, attempt) => {
      if (attempt > maxTry) return reject(new Error("no free port"));
      const srv = net.createServer();
      srv.once("error", () => { tryListen(p + 1, attempt + 1); });
      srv.listen(p, () => { srv.close(() => resolve(p)); });
    };
    tryListen(port, 0);
  });
}

// --- Чтение настроек (settings.json) ---
// Файл читается на каждое событие (без кэша): настройки меняются в UI, а
// подписываться на их изменения из main-процесса некуда — файл маленький,
// события происходят редко (закрытие/сворачивание окна, старт приложения).
function readSettings() {
  try {
    const storage =
      process.env.PERSONAL_APP_STORAGE || path.join(__dirname, "..", "storage");
    return JSON.parse(fs.readFileSync(path.join(storage, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// Точечная запись в settings.json (мержим в существующий объект, чтобы не
// затирать секции, сохранённые сервером).
function patchSettings(patch) {
  try {
    const storage =
      process.env.PERSONAL_APP_STORAGE || path.join(__dirname, "..", "storage");
    const file = path.join(storage, "settings.json");
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* файла ещё нет */ }
    const merged = { ...cur };
    for (const [section, values] of Object.entries(patch)) {
      merged[section] = { ...(merged[section] || {}), ...values };
    }
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
  } catch { /* окно не должно падать из-за неудачной записи размера */ }
}

// --- Автозапуск с Windows ---
// app.setLoginItemSettings — штатный механизм (реестр Run). Вызывается на старте
// и при каждом событии close/minimize (перечитываем настройки — там же дёшево).
function applyAutoLaunch() {
  try {
    const want = readSettings()?.general?.autoLaunch === true;
    const cur = app.getLoginItemSettings();
    if (cur.openAtLogin !== want) {
      app.setLoginItemSettings({ openAtLogin: want, path: process.execPath });
    }
  } catch { /* в dev-режиме setLoginItemSettings может быть недоступен */ }
}

// --- Трей ---
let tray = null;

// Иконка трея: берём иконку самого exe (Windows умеет извлекать её нативно).
async function makeTrayIcon() {
  try {
    const icon = await app.getFileIcon(process.execPath, { size: "normal" });
    if (!icon.isEmpty()) return icon;
  } catch { /* фолбэк ниже */ }
  const { nativeImage } = require("electron");
  return nativeImage.createEmpty();
}

async function ensureTray() {
  if (tray) return tray;
  const { Tray, Menu } = require("electron");
  tray = new Tray(await makeTrayIcon());
  tray.setToolTip("PersonalApp");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть", click: () => showWindow() },
    { type: "separator" },
    { label: "Выход", click: () => { quitting = true; app.quit(); } },
  ]));
  // Левый клик по иконке — показать окно.
  tray.on("click", () => showWindow());
  return tray;
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
  try { tray?.destroy(); } catch { /* уже уничтожен */ }
  tray = null;
}

// Ожидание сервера: иначе окно откроется пустым.
function waitForServer(port, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => retry());
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tryOnce, 250);
    };
    tryOnce();
  });
}

let win = null;
// Флаг «выход по-настоящему» (через меню трея / quit): без него closeToTray
// перехватил бы и штатный выход из приложения.
let quitting = false;

function registerWindowControls() {
  ipcMain.on("win:minimize", () => win?.minimize());
  ipcMain.on("win:toggle-maximize", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win:close", () => win?.close());
}

async function createWindow() {
  // Токен на одну сессию, чтобы сторонние запросы к локальному API не проходили.
  // Уходит в preload через additionalArguments (см. appBridge.getToken).
  const token = crypto.randomBytes(24).toString("hex");

  const port = await findFreePort(4000);
  startServer(port, { token });

  // Размер окна: берём из настроек (window.*); при rememberSize запоминаем
  // последний размер на закрытии и восстанавливаем на следующем запуске.
  const ws = readSettings()?.window || {};
  const remembered = readSettings()?.window?.lastSize || {};
  const width = Math.max(800, Number(ws.width) || 1180);
  const height = Math.max(600, Number(ws.height) || 820);
  const startW = ws.rememberSize !== false && remembered.width ? Number(remembered.width) : width;
  const startH = ws.rememberSize !== false && remembered.height ? Number(remembered.height) : height;

  // Окно полупрозрачное и без системной рамки.
  // Вся матовость — из CSS (blur-фильтры и цвета).
  win = new BrowserWindow({
    width: startW,
    height: startH,
    minWidth: 800,
    minHeight: 600,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--pa-token=${token}`],
    },
  });

  win.setMenuBarVisibility(false);

  const ready = await waitForServer(port);
  if (!ready) console.error("[electron] server health-check failed; loading anyway");
  win.loadURL(`http://127.0.0.1:${port}`);

  // window.rememberSize: последний размер окна пишется в settings.json
  // (window.lastSize), чтобы следующее открытие было в нём же.
  win.on("close", () => {
    try {
      const cfg = readSettings()?.window || {};
      if (cfg.rememberSize !== false && !win.isMaximized() && !win.isMinimized()) {
        const [w, h] = win.getSize();
        patchSettings({ window: { lastSize: { width: w, height: h } } });
      }
    } catch { /* любое состояние окна ок */ }
  });

  // general.minimizeToTray: сворачивание прячет окно в трей вместо таскбара.
  win.on("minimize", () => {
    try {
      if (readSettings()?.general?.minimizeToTray === true) {
        win.hide();
        void ensureTray();
      }
    } catch { /* обычное сворачивание */ }
  });

  // general.closeToTray: «крестик» сворачивает в трей вместо выхода.
  win.on("close", (e) => {
    try {
      if (quitting || readSettings()?.general?.closeToTray !== true) return;
      e.preventDefault();
      win.hide();
      void ensureTray();
    } catch { /* обычное закрытие */ }
  });

  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  registerWindowControls();
  if (safeStorage) app.setName("PersonalApp");
  // general.autoLaunch: синхронизируем автозапуск с настройками при каждом старте.
  applyAutoLaunch();
  createWindow();
});

app.on("before-quit", () => { quitting = true; });

app.on("window-all-closed", () => {
  app.quit();
});

// При выходе LHM останавливается, если он был запущен этим приложением.
app.on("will-quit", () => {
  try { require("../server/monitor").stopLhm(); } catch { /* пофиг */ }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});