const { app, BrowserWindow, safeStorage, ipcMain, session } = require("electron");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
// Вычисляем путь к storage ДО require("../server"): модуль выставляет
// process.env.MOONAPP_STORAGE, который читают server/config.js и monitor.
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

// --- Одна инстанция приложения ---
// Повторный запуск (двойной клик по ярлыку, клик по закреплённой иконке) раньше
// поднимал ВТОРУЮ копию: свой BrowserWindow, свой Express-сервер на следующем
// свободном порту и ту же папку storage. Две копии конкурировали за
// settings.json/БД/порт/WinDivert — окно «зависало», а скрытая копия оставалась
// висеть в панели задач. Теперь экземпляр один: второй запуск лишь поднимает
// окно уже работающего приложения и сразу завершается.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => { showWindow(); });
}

// --- Логирование main-процесса ---
// Всё, что Electron пишет в console.warn/error (обновления, трей, окно),
// дублируется в storage/logs/main.log. Этот файл попадает в диагностический
// отчёт кнопки «Собрать логи» в Настройках. Ротация: >2 МБ → main.1.log.
// Дополнительно ключевые события main уходят в общий журнал audit.log —
// тогда они видны в отчёте в общей хронологии с действиями пользователя.
const MAIN_LOG = path.join(STORAGE_DIR, "logs", "main.log");
let mainLogSize = -1;

// require("../server/logger") безопасен: storagePath уже выставил
// MOONAPP_STORAGE, поэтому logger пишет в правильный storage.
const serverLogger = (() => { try { return require("../server/logger"); } catch { return null; } })();

function mlog(level, event, data) {
  try { serverLogger?.log?.(level, event, data); } catch { /* ignore */ }
}

function appendMainLog(level, args) {
  try {
    fs.mkdirSync(path.dirname(MAIN_LOG), { recursive: true });
    const text = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    const line = `${new Date().toISOString()}  ${level}  ${text}\n`;
    if (mainLogSize < 0) mainLogSize = fs.existsSync(MAIN_LOG) ? fs.statSync(MAIN_LOG).size : 0;
    if (mainLogSize > 2 * 1024 * 1024) {
      try { fs.renameSync(MAIN_LOG, MAIN_LOG.replace(/\.log$/, ".1.log")); } catch { /* ignore */ }
      mainLogSize = 0;
    }
    fs.appendFileSync(MAIN_LOG, line);
    mainLogSize += Buffer.byteLength(line);
  } catch { /* приложение не должно падать из-за лога */ }
}

for (const lvl of ["warn", "error"]) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...args) => { appendMainLog(lvl.toUpperCase(), args); orig(...args); };
}

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

// Иконка трея: сначала пробуем настоящий .ico-файл (build/icon.ico). Раньше
// иконка бралась только из exe через app.getFileIcon(..., { size: "normal" }) —
// на frameless/transparent-окне она часто приходила пустой/битой, и трей
// показывал пустой квадрат. Файловый .ico ресайзим под системный размер трея.
let trayIconCache = null;

function trayIconCandidates() {
  const list = [];
  // packaged: icon.ico кладётся в resources/ (build.extraResources в package.json).
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, "icon.ico"));
  // dev: build/icon.ico рядом с проектом.
  list.push(path.join(__dirname, "..", "build", "icon.ico"));
  return list;
}

async function makeTrayIcon() {
  const { nativeImage } = require("electron");
  if (trayIconCache) return trayIconCache;
  for (const p of trayIconCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (img && !img.isEmpty()) {
        trayIconCache = img.resize({ width: 16, height: 16 });
        return trayIconCache;
      }
    } catch { /* пробуем следующий источник */ }
  }
  // Фолбэк: иконка самого exe (Windows умеет извлекать её нативно).
  try {
    const icon = await app.getFileIcon(process.execPath, { size: "small" });
    if (icon && !icon.isEmpty()) { trayIconCache = icon; return trayIconCache; }
  } catch { /* ниже — пустая картинка */ }
  return nativeImage.createEmpty();
}

async function ensureTray() {
  if (tray) return tray;
  const { Tray, Menu } = require("electron");
  tray = new Tray(await makeTrayIcon());
  tray.setToolTip("MoonApp");
  tray.setContextMenu(Menu.buildFromTemplate(await trayTemplate()));
  // Левый клик и двойной клик по иконке — показать окно.
  tray.on("click", () => showWindow());
  tray.on("double-click", () => showWindow());
  mlog("action", "tray.create", {});
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
        "x-moonapp-token": apiToken || "",
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
      click: () => { void zapretApi("/start", { strategyId: s.id, mode: (readSettings()?.zapret?.mode === "process" ? "process" : "service") }).then(() => refreshTray()); },
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
  try {
    // Окно могло остаться в состоянии minimized после hide() — без restore()
    // show() не возвращает его к жизни, и клик выглядит «зависшим».
    if (win.isMinimized()) win.restore();
    win.setSkipTaskbar(false);
    win.show();
    win.focus();
    // Прозрачное frameless-окно после hide/show иногда не перерисовывается —
    // просим Chromium отрисовать кадр заново.
    try { win.webContents.invalidate?.(); } catch { /* не критично */ }
    mlog("action", "win.show", {});
  } catch (e) {
    mlog("error", "win.show_failed", { error: e?.message || String(e) });
  }
  try { tray?.destroy(); } catch { /* уже уничтожен */ }
  tray = null;
}

/**
 * Скрыть окно в трей. Трей создаём ДО hide() и снимаем кнопку с панели задач:
 * иначе при закрытии/сворачивании окно остаётся висеть в таскбаре, а по клику
 * на него ничего не происходит (выглядит как зависание).
 */
async function hideToTray(reason) {
  if (!win) return;
  try { await ensureTray(); } catch { /* трей мог не создаться — прячем всё равно */ }
  try { win.setSkipTaskbar(true); } catch { /* ignore */ }
  try { win.hide(); } catch { /* ignore */ }
  mlog("action", "win.hide", { reason });
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
  tokenFile = path.join(os.tmpdir(), `moonapp-token-${crypto.randomBytes(6).toString("hex")}`);
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

  // Позиция окна (window.lastPos): помним её рядом с размером, но восстанавливаем
  // только если окно попадает на текущий набор мониторов — иначе после смены
  // конфигурации экранов окно оказывалось бы за пределами рабочего стола.
  let startX, startY;
  const rememberedPos = readSettings()?.window?.lastPos || {};
  if (ws.rememberSize !== false && Number.isFinite(Number(rememberedPos.x)) && Number.isFinite(Number(rememberedPos.y))) {
    try {
      const { screen } = require("electron");
      const px = Number(rememberedPos.x), py = Number(rememberedPos.y);
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return px + startW > a.x + 40 && px < a.x + a.width - 40 && py + 40 > a.y && py < a.y + a.height - 40;
      });
      if (onScreen) { startX = px; startY = py; }
    } catch { /* screen недоступен — остаётся позиция по умолчанию */ }
  }

  // Окно полупрозрачное и без системной рамки.
  // Вся матовость — из CSS (blur-фильтры и цвета).
  win = new BrowserWindow({
    width: startW,
    height: startH,
    ...(startX !== undefined ? { x: startX, y: startY } : {}),
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
      additionalArguments: tokenFile ? [`--moonapp-token-file=${tokenFile}`] : [],
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

  // window.rememberSize: последние размер И позиция окна пишутся в settings.json
  // (window.lastSize/lastPos), чтобы следующее открытие было в них же.
  win.on("close", () => {
    try {
      const cfg = readSettings()?.window || {};
      if (cfg.rememberSize !== false && !win.isMaximized() && !win.isMinimized()) {
        const [w, h] = win.getSize();
        const [x, y] = win.getPosition();
        patchSettings({ window: { lastSize: { width: w, height: h }, lastPos: { x, y } } });
      }
    } catch { /* любое состояние окна ок */ }
  });

  // general.minimizeToTray: сворачивание прячет окно в трей вместо таскбара.
  win.on("minimize", () => {
    try {
      if (readSettings()?.general?.minimizeToTray !== true) return;
      // hide() синхронно внутри события minimize оставляет окно в «полу-свёрнутом»
      // состоянии (баг Electron): в панели задач остаётся кнопка, а окно мёртвое.
      // Откладываем до следующего тика, когда сворачивание завершится.
      setImmediate(() => { void hideToTray("minimize"); });
    } catch { /* обычное сворачивание */ }
  });

  // general.closeToTray: «крестик» сворачивает в трей вместо выхода.
  win.on("close", (e) => {
    try {
      if (quitting || readSettings()?.general?.closeToTray !== true) return;
      e.preventDefault();
      void hideToTray("close");
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
      mlog("info", "updater.downloaded", { version: info.version });
      // Системное уведомление + диалог с предложением перезапуска.
      try {
        const n = new Notification({
          title: "MoonApp",
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
    autoUpdater.on("error", (err) => { mlog("error", "updater.error", { error: err?.message || String(err) }); console.error("[updater]", err?.message || err); });
    updaterReady = true;
    if (updatesEnabled()) { mlog("info", "updater.check", { trigger: "startup" }); void autoUpdater.checkForUpdates().catch(() => {}); }
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
  mlog("action", "updater.toggle", { enabled });
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
  if (!gotSingleInstanceLock) return;
  registerWindowControls();
  if (safeStorage) app.setName("MoonApp");
  mlog("info", "app.start", { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform });
  // Путь данных виден в диагностическом отчёте — сразу понятно, куда всё пишется.
  mlog("info", "app.storage", { dir: STORAGE_DIR, packaged: app.isPackaged });
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

// Открыть каталог, в котором установлено приложение (кнопка в верхней панели,
// слева от кнопки прокси). В собранной версии — папка рядом с exe, в dev — корень проекта.
ipcMain.handle("shell:open-app-dir", () => {
  try {
    const { shell } = require("electron");
    const dir = app.isPackaged ? path.dirname(app.getPath("exe")) : path.join(__dirname, "..");
    void shell.openPath(dir);
    mlog("action", "shell.open_app_dir", { dir });
    return { ok: true, dir };
  } catch (e) {
    mlog("error", "shell.open_app_dir_failed", { error: e?.message || String(e) });
    return { ok: false, error: e?.message || String(e) };
  }
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

// --- Встроенный прокси: глобальный прокси Chromium ---
// Ядро (sing-box) слушает локальный SOCKS5/HTTP. Здесь мы заворачиваем ВЕСЬ
// сетевой стек Chromium (картинки-превью, внешние ресурсы) в этот прокси.
// Локальные адреса (<local> = 127.0.0.1/::1/localhost) всегда идут мимо —
// иначе фронт ушёл бы в петлю на собственный API Express.
// Per-page фильтрация на уровне Chromium невозможна (все страницы SPA с одного
// origin) — она реализована в backend по API-роутам (см. server/db.js ppr*).
ipcMain.handle("proxy:apply-session", async (_e, cfg) => {
  try {
    const rules = cfg && cfg.proxyRules ? String(cfg.proxyRules) : null;
    if (rules) {
      await session.defaultSession.setProxy({
        mode: "fixed_servers",
        proxyRules: rules,
        proxyBypassRules: "<local>",
      });
    } else {
      await session.defaultSession.setProxy({ mode: "direct" });
    }
    mlog("action", "proxy.apply_session", { rules: rules || "direct" });
    return { ok: true, proxyRules: rules };
  } catch (e) {
    mlog("error", "proxy.apply_session_failed", { error: e?.message || String(e) });
    return { ok: false, error: e?.message || String(e) };
  }
});

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