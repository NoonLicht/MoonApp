const { app, BrowserWindow, safeStorage, ipcMain } = require("electron");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
// Вычисляем путь к storage ДО require("../server"): модуль выставляет
// process.env.PERSONAL_APP_STORAGE, который читают server/config.js и monitor.
const { STORAGE_DIR } = require("./storagePath");
const { startServer } = require("../server");
// Автообновление (работает только в packaged-сборке; в dev отключено ниже).
const { autoUpdater } = require("electron-updater");

// Минимальный размер окна. Ниже этой ширины/высоты вёрстка уходит в
// «одноколоночный» режим (вертикальный док, адаптивный тулбар), поэтому
// меньше — нельзя: интерфейс начнёт обрезаться.
const MIN_WIN_WIDTH = 640;
const MIN_WIN_HEIGHT = 520;

// Аппаратное ускорение Chromium. По умолчанию вкл.; если в настройках
// performance.hardwareAcceleration=false — выключается ДО создания окна, иначе не подхватится.
function applyHardwareAcceleration() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, "settings.json"), "utf8"));
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
    return JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// Точечная запись в settings.json (мержим в существующий объект, чтобы не
// затирать секции, сохранённые сервером). Файл пишут два процесса (main и
// Express-роуты), поэтому берём короткий lock-файл: кто не смог захватить за
// 2 секунды — пропускает запись (потеря размера окна не критична).
function withSettingsLock(fn) {
  const lock = path.join(STORAGE_DIR, "settings.lock");
  let fd = null;
  for (let i = 0; i < 20 && fd === null; i++) {
    try { fd = fs.openSync(lock, "wx"); } catch { const t0 = Date.now(); while (Date.now() - t0 < 100) { /* busy-wait 100 мс */ } }
  }
  if (fd === null) return false;
  try { return fn() !== false; } finally { try { fs.closeSync(fd); fs.rmSync(lock, { force: true }); } catch { /* ignore */ } }
}

function patchSettings(patch) {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true }); // storage может ещё не существовать
    const file = path.join(STORAGE_DIR, "settings.json");
    withSettingsLock(() => {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* файла ещё нет */ }
      const merged = { ...cur };
      for (const [section, values] of Object.entries(patch)) {
        merged[section] = { ...(merged[section] || {}), ...values };
      }
      fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
      return true;
    });
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
// Временный файл с API-токеном (см. createWindow) — удаляется при выходе.
let tokenFile = null;

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
  tray.setContextMenu(Menu.buildFromTemplate(await trayTemplate()));
  // Левый клик по иконке — показать окно.
  tray.on("click", () => showWindow());
  return tray;
}

// --- Трей: быстрое переключение стратегий DPI-обхода (zapret) ---
// Трей обращается к локальному API напрямую (тот же порт/токен, что у фронта).
let apiPort = null;
let apiToken = null;

function zapretApi(urlPath, body) {
  return new Promise((resolve) => {
    if (!apiPort) return resolve(null);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port: apiPort, path: `/api/zapret${urlPath}`, method: payload ? "POST" : "GET",
      headers: {
        "x-pa-token": apiToken || "",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      timeout: 8000,
    }, (res) => {
      let raw = "";
      res.on("data", (d) => { raw += d; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Перестроить меню трея (после переключения стратегии / старта/стопа). */
async function refreshTray() {
  const { Menu } = require("electron");
  try { if (tray) tray.setContextMenu(Menu.buildFromTemplate(await trayTemplate())); } catch { /* окно уже уничтожено */ }
}

async function trayTemplate() {
  const items = [
    { label: "Открыть", click: () => showWindow() },
    { label: "Проверить обновления", visible: !!app.isPackaged, click: () => { void autoUpdater.checkForUpdates().catch(() => {}); } },
    { type: "separator" },
  ];
  // Подменю «Обход блокировок»: статус + конфиги по группам + Стоп + обновление.
  const [strategies, status, update] = await Promise.all([
    zapretApi("/strategies"), zapretApi("/status"), zapretApi("/update"),
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
    const strategyItem = (s) => ({
      label: s.name,
      type: "checkbox",
      checked: !!active && current === s.id,
      click: () => { void zapretApi("/start", { strategyId: s.id, mode: "process" }).then(() => refreshTray()); },
    });
    const grouped = groups
      .map(([g, title]) => {
        const list = strategies.filter((s) => s.group === g);
        return list.length ? { label: `${title} (${list.length})`, submenu: list.map(strategyItem) } : null;
      })
      .filter(Boolean);
    const ungrouped = strategies.filter((s) => !groups.some(([g]) => g === s.group));
    const subItems = [
      { label: active ? `● Активно: ${current || "—"}` : "○ Остановлено", enabled: false },
      { label: `Версия: ${version || "не установлена"}`, enabled: false },
      { type: "separator" },
      ...(ungrouped.length ? [...ungrouped.map(strategyItem)] : []),
      ...grouped,
      { type: "separator" },
      { label: "Остановить обход", enabled: !!active, click: () => { void zapretApi("/stop").then(() => refreshTray()); } },
    ];
    // Обновление движка прямо из трея (прогресс виден на странице Bypass).
    if (update && !update.error) {
      const has = !!update.hasUpdate;
      subItems.push({
        label: has ? `⬇ Обновить zapret до ${update.latest}` : `⬇ Переустановить zapret ${update.installed || ""}`,
        click: () => { void zapretApi("/install", { tag: has ? update.latest : undefined }).then(() => refreshTray()); },
      });
    }
    items.push({ label: "Обход блокировок (zapret)", submenu: subItems });
  }
  items.push(
    { type: "separator" },
    { label: "Выход", click: () => { quitting = true; app.quit(); } },
  );
  return items;
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
  // В argv он больше не передаётся (argv любого процесса виден через WMI) —
  // вместо этого токен пишется во временный файл 0600, путь уходит в preload,
  // файл удаляется при выходе.
  const token = crypto.randomBytes(24).toString("hex");
  const os = require("os");
  tokenFile = path.join(os.tmpdir(), `pa-token-${crypto.randomBytes(6).toString("hex")}`);
  try { fs.writeFileSync(tokenFile, token, { mode: 0o600 }); } catch { tokenFile = null; }

  const port = await findFreePort(4000);
  startServer(port, { token });
  // Порт/токен для меню трея (быстрое переключение стратегий zapret).
  apiPort = port;
  apiToken = token;

  // Размер окна: берём из настроек (window.*); при rememberSize запоминаем
  // последний размер на закрытии и восстанавливаем на следующем запуске.
  // Минимальный «оптимальный» размер: вёрстка рассчитана и проверена начиная
  // с этой ширины/высоты (одна колонка, вертикальный док, адаптивный тулбар).
  const ws = readSettings()?.window || {};
  const remembered = readSettings()?.window?.lastSize || {};
  const width = Math.max(MIN_WIN_WIDTH, Number(ws.width) || 1180);
  const height = Math.max(MIN_WIN_HEIGHT, Number(ws.height) || 820);
  const startW = ws.rememberSize !== false && remembered.width ? Number(remembered.width) : width;
  const startH = ws.rememberSize !== false && remembered.height ? Number(remembered.height) : height;

  // Окно полупрозрачное и без системной рамки.
  // Вся матовость — из CSS (blur-фильтры и цвета).
  win = new BrowserWindow({
    width: startW,
    height: startH,
    minWidth: MIN_WIN_WIDTH,
    minHeight: MIN_WIN_HEIGHT,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Токен передаётся файлом, а не argv (argv виден другим процессам).
      additionalArguments: tokenFile ? [`--pa-token-file=${tokenFile}`] : [],
      sandbox: false,
    },
  });

  // CSP: даже если чужой HTML/Markdown пробьёт санитайзер — инлайн-скрипты
  // и внешние загрузки запрещены. Собственный бандл — 'self'.
  win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; " +
          "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'self'",
        ],
      },
    });
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

// --- Автообновление (только в packaged-сборке) ---
// Источник — GitHub Releases (build.publish в package.json). Новая версия
// скачивается в фоне; установка — по подтверждению пользователя (перезапуск).
// Автообновление можно выключить в Настройках (settings.json → general.autoUpdate).
// В dev-режиме проверка отключена: updatable=false у неупакованного приложения.
let updateTimer = null;
let updaterReady = false;

function updatesEnabled() {
  try { return readSettings()?.general?.autoUpdate !== false; } catch { return true; }
}

function scheduleUpdateTimer() {
  if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  if (!updaterReady || !updatesEnabled()) return;
  // Повторная проверка каждые 4 часа, пока приложение открыто.
  updateTimer = setInterval(() => { void autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
}

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  try {
    autoUpdater.logger = console;
    autoUpdater.autoDownload = updatesEnabled();
    autoUpdater.on("update-downloaded", (info) => {
      const { dialog, Notification } = require("electron");
      // Системное уведомление + диалог с предложением перезапуска.
      try {
        const n = new Notification({
          title: "PersonalApp",
          body: `Обновление ${info.version} скачано и готово к установке`,
        });
        n.on("click", () => showWindow());
        n.show();
      } catch { /* уведомления могут быть недоступны */ }
      dialog.showMessageBox({
        type: "info",
        message: `Обновление ${info.version} скачано`,
        detail: "Установить сейчас? Приложение перезапустится. Данные в storage не затрагиваются.",
        buttons: ["Перезапустить и установить", "Позже"],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) { quitting = true; autoUpdater.quitAndInstall(); }
      }).catch(() => { /* окно уже закрыто и т.п. */ });
    });
    autoUpdater.on("error", (err) => console.error("[updater]", err?.message || err));
    updaterReady = true;
    if (updatesEnabled()) void autoUpdater.checkForUpdates().catch(() => {});
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
  } catch (e) {
    return { ok: false, reason: e?.message || "error" };
  }
});

// Вкл/выкл автообновления (кнопка в Настройках). Состояние — в settings.json.
ipcMain.handle("updates:toggle", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev" };
  const enabled = !updatesEnabled();
  try { patchSettings({ general: { autoUpdate: enabled } }); } catch { /* ок, статус вернём как есть */ }
  if (updaterReady) {
    autoUpdater.autoDownload = enabled;
    if (enabled) void autoUpdater.checkForUpdates().catch(() => {});
    scheduleUpdateTimer();
  }
  return { ok: true, enabled };
});

// Ручное скачивание обновления: проверка → downloadUpdate. По завершении
// сработает «update-downloaded» (системное уведомление + диалог установки).
ipcMain.handle("updates:download", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev" };
  try {
    autoUpdater.autoDownload = true; // ручная кнопка — всегда скачиваем
    const r = await autoUpdater.checkForUpdates();
    const v = r?.updateInfo?.version || null;
    const isUpdate = !!v && v !== app.getVersion();
    if (!isUpdate) return { ok: true, available: false, version: null };
    void autoUpdater.downloadUpdate().catch((e) => console.error("[updater]", e?.message || e));
    return { ok: true, available: true, version: v, downloading: true };
  } catch (e) {
    return { ok: false, reason: e?.message || "error" };
  }
});

app.whenReady().then(() => {
  registerWindowControls();
  if (safeStorage) app.setName("PersonalApp");
  // general.autoLaunch: синхронизируем автозапуск с настройками при каждом старте.
  applyAutoLaunch();
  createWindow();
  // Проверка обновлений — после создания окна, чтобы не задерживать старт.
  setTimeout(() => setupAutoUpdates(), 5000);
});

app.on("before-quit", () => {
  quitting = true;
  try { if (tokenFile) fs.rmSync(tokenFile, { force: true }); } catch { /* ignore */ }
});

// Reveal in File Explorer: выделить файл/папку в проводнике (контекстные меню
// страниц видео/архива вызывают через appBridge.revealPath).
ipcMain.handle("shell:reveal", (_e, p) => {
  try {
    const { shell } = require("electron");
    const full = String(p || "");
    if (!path.isAbsolute(full)) return false;
    shell.showItemInFolder(full);
    return true;
  } catch { return false }
});

// Обновить подменю zapret в трее: страница Bypass Control вызывает после
// изменения стратегий/профилей, чтобы быстрые переключения были актуальны.
ipcMain.on("bypass:tray-refresh", () => { void refreshTray(); });

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