const { app, BrowserWindow, safeStorage, ipcMain, session, globalShortcut } = require("electron");
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
// 720px — нижняя граница шкалы брейкпоинтов: CSS-правила для ещё более
// узких окон (≤700 / ≤640 / ≤520 в src/styles/*.css) в окне приложения
// недостижимы, они остаются страховкой для запуска в браузере (vite dev).
const MIN_WIN_WIDTH = 720;
const MIN_WIN_HEIGHT = 520;

// Аппаратное ускорение Chromium. По умолчанию вкл.; если в настройках
// performance.hardwareAcceleration=false — выключается ДО создания окна, иначе не подхватится.
function applyHardwareAcceleration() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, "settings.json"), "utf8"));
    if (raw?.performance?.hardwareAcceleration === false) {
      app.disableHardwareAcceleration();
      return;
    }
  } catch {
    // Настроек нет — остаётся дефолт (ускорение включено).
  }
  // По умолчанию Chromium сверяет GPU/драйвер со своим внутренним
  // блок-листом и на некоторых связках (особенно ноутбуки с гибридной
  // графикой, старые/нестандартные драйверы) молча откатывается на
  // программный рендер — окно выглядит нормально, но нагрузка на GPU при
  // скролле/анимациях не растёт вообще, а частота кадров не разгоняется
  // выше ~60 даже на 120/180-герцовых мониторах. ignore-gpu-blocklist
  // заставляет Chromium использовать GPU-композитинг несмотря на блок-лист;
  // enable-gpu-rasterization/zero-copy — снижают CPU-часть конвейера отрисовки,
  // чтобы композитор реально успевал за высокой частотой обновления.
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
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
  app.on("second-instance", () => {
    showWindow();
  });
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
const serverLogger = (() => {
  try {
    return require("../server/logger");
  } catch {
    return null;
  }
})();

function mlog(level, event, data) {
  try {
    serverLogger?.log?.(level, event, data);
  } catch {
    /* ignore */
  }
}

function appendMainLog(level, args) {
  try {
    fs.mkdirSync(path.dirname(MAIN_LOG), { recursive: true });
    const text = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    const line = `${new Date().toISOString()}  ${level}  ${text}\n`;
    if (mainLogSize < 0) mainLogSize = fs.existsSync(MAIN_LOG) ? fs.statSync(MAIN_LOG).size : 0;
    if (mainLogSize > 2 * 1024 * 1024) {
      try {
        fs.renameSync(MAIN_LOG, MAIN_LOG.replace(/\.log$/, ".1.log"));
      } catch {
        /* ignore */
      }
      mainLogSize = 0;
    }
    fs.appendFileSync(MAIN_LOG, line);
    mainLogSize += Buffer.byteLength(line);
  } catch {
    /* приложение не должно падать из-за лога */
  }
}

for (const lvl of ["warn", "error"]) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...args) => {
    appendMainLog(lvl.toUpperCase(), args);
    orig(...args);
  };
}

// Порт больше не статичный 4000: он предсказуем (любой процесс мог просто
// постучаться в 127.0.0.1:4000), а токен сам по себе статику не защищал (см.
// authMiddleware в server/ts/index.ts). Стартуем поиск со случайного порта в
// диапазоне 20000-59999 и, как раньше, идём вверх, пока не найдём свободный.
function findFreePort(start = 20000 + Math.floor(Math.random() * 40000), maxTry = 100) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryListen = (p, attempt) => {
      if (attempt > maxTry) return reject(new Error("no free port"));
      const srv = net.createServer();
      srv.once("error", () => {
        tryListen(p + 1, attempt + 1);
      });
      srv.listen(p, () => {
        srv.close(() => resolve(p));
      });
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
    try {
      fd = fs.openSync(lock, "wx");
    } catch {
      const t0 = Date.now();
      while (Date.now() - t0 < 100) {
        /* busy-wait 100 мс */
      }
    }
  }
  if (fd === null) return false;
  try {
    return fn() !== false;
  } finally {
    try {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function patchSettings(patch) {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true }); // storage может ещё не существовать
    const file = path.join(STORAGE_DIR, "settings.json");
    withSettingsLock(() => {
      let cur = {};
      try {
        cur = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        /* файла ещё нет */
      }
      const merged = { ...cur };
      for (const [section, values] of Object.entries(patch)) {
        merged[section] = { ...(merged[section] || {}), ...values };
      }
      fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
      return true;
    });
  } catch {
    /* окно не должно падать из-за неудачной записи размера */
  }
}

// --- Автозапуск с Windows ---
// app.setLoginItemSettings — штатный механизм (реестр Run). Вызывается на старте,
// при закрытии/сворачивании окна и СРАЗУ при переключении галочки в настройках
// (renderer → appBridge.applyAutoLaunch → ipcMain "app:autolaunch"). Без последнего
// шага настройка вступала в силу только после перезапуска приложения.
function applyAutoLaunch() {
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
  } catch (e) {
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

function registerCommandPaletteHotkey() {
  try {
    globalShortcut.unregister(COMMAND_PALETTE_ACCELERATOR);
  } catch {
    /* не было зарегистрировано — не критично */
  }
  const enabled = readSettings()?.general?.commandPaletteHotkey !== false;
  if (!enabled) return;
  try {
    const ok = globalShortcut.register(COMMAND_PALETTE_ACCELERATOR, () => {
      showWindow();
      win?.webContents.send("app:open-palette");
    });
    if (!ok) mlog("warn", "hotkey.register_failed", { accelerator: COMMAND_PALETTE_ACCELERATOR });
  } catch (e) {
    mlog("error", "hotkey.register_error", { error: e?.message || String(e) });
  }
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
    const req = http.request(
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
async function refreshTray() {
  const { Menu } = require("electron");
  try {
    if (tray) tray.setContextMenu(Menu.buildFromTemplate(await trayTemplate()));
  } catch {
    /* окно уже уничтожено */
  }
}

async function trayTemplate() {
  const items = [
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
    const strategyItem = (s) => ({
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
    const subItems = [
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
        quitting = true;
        app.quit();
      },
    },
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
    try {
      win.webContents.invalidate?.();
    } catch {
      /* не критично */
    }
    mlog("action", "win.show", {});
  } catch (e) {
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

/**
 * Скрыть окно в трей. Трей создаём ДО hide() и снимаем кнопку с панели задач:
 * иначе при закрытии/сворачивании окно остаётся висеть в таскбаре, а по клику
 * на него ничего не происходит (выглядит как зависание).
 */
async function hideToTray(reason) {
  if (!win) return;
  try {
    await ensureTray();
  } catch {
    /* трей мог не создаться — прячем всё равно */
  }
  try {
    win.setSkipTaskbar(true);
  } catch {
    /* ignore */
  }
  try {
    win.hide();
  } catch {
    /* ignore */
  }
  mlog("action", "win.hide", { reason });
}

// Ожидание сервера: иначе окно откроется пустым.
function waitForServer(port, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 1500 },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("error", () => retry());
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
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
  try {
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  } catch {
    tokenFile = null;
  }

  const port = await findFreePort();
  startServer(port, { token });
  // Скрапер форума ходит на rutracker сетевым стеком ЭТОЙ сессии: настоящие
  // TLS/HTTP2-отпечатки и те же куки, что прошли Cloudflare в окне входа
  // (server/ts/trackerScraper.ts → bindChromiumSession). Ошибка привязки не
  // критична: тогда поиск пойдёт обычным fetch с per-page прокси.
  try {
    require("../server/trackerScraper").bindChromiumSession(trackerSession());
  } catch (e) {
    mlog("error", "tracker.bind_session_failed", { error: e?.message || String(e) });
  }
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
  const startH =
    ws.rememberSize !== false && remembered.height ? Number(remembered.height) : height;

  // Позиция окна (window.lastPos): помним её рядом с размером, но восстанавливаем
  // только если окно попадает на текущий набор мониторов — иначе после смены
  // конфигурации экранов окно оказывалось бы за пределами рабочего стола.
  let startX, startY;
  const rememberedPos = readSettings()?.window?.lastPos || {};
  if (
    ws.rememberSize !== false &&
    Number.isFinite(Number(rememberedPos.x)) &&
    Number.isFinite(Number(rememberedPos.y))
  ) {
    try {
      const { screen } = require("electron");
      const px = Number(rememberedPos.x),
        py = Number(rememberedPos.y);
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return (
          px + startW > a.x + 40 &&
          px < a.x + a.width - 40 &&
          py + 40 > a.y &&
          py < a.y + a.height - 40
        );
      });
      if (onScreen) {
        startX = px;
        startY = py;
      }
    } catch {
      /* screen недоступен — остаётся позиция по умолчанию */
    }
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

  // Токен теперь нужен и для статики/навигации (server/ts/index.ts →
  // authMiddleware), а не только для fetch() из renderer. Сам renderer не может
  // проставить заголовок на запрос загрузки страницы (win.loadURL) или её
  // подресурсов (JS/CSS), поэтому подставляем его здесь, на уровне сессии —
  // любой сторонний браузер, открывший http://127.0.0.1:<port> напрямую,
  // этот перехватчик не затрагивает и получит 401.
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`http://127.0.0.1:${port}/*`] },
    (details, cb) => {
      details.requestHeaders["x-moonapp-token"] = token;
      cb({ requestHeaders: details.requestHeaders });
    },
  );

  // CSP: даже если чужой HTML/Markdown пробьёт санитайзер — инлайн-скрипты
  // и внешние загрузки запрещены. Собственный бандл — 'self'.
  win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; " +
            // frame-src 'self' нужен встроенному просмотру веб-архивов (.sitebak):
            // страницы отдаёт локальный API, скрипты в них вырезаны, CSP документа
            // — script-src 'none' (см. server/routes/archive.js → serveHtml).
            // Внешние фреймы по-прежнему запрещены.
            "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; object-src 'none'; frame-src 'self'; base-uri 'self'",
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
    } catch {
      /* любое состояние окна ок */
    }
  });

  // general.minimizeToTray: сворачивание прячет окно в трей вместо таскбара.
  win.on("minimize", () => {
    try {
      if (readSettings()?.general?.minimizeToTray !== true) return;
      // hide() синхронно внутри события minimize оставляет окно в «полу-свёрнутом»
      // состоянии (баг Electron): в панели задач остаётся кнопка, а окно мёртвое.
      // Откладываем до следующего тика, когда сворачивание завершится.
      setImmediate(() => {
        void hideToTray("minimize");
      });
    } catch {
      /* обычное сворачивание */
    }
  });

  // general.closeToTray: «крестик» сворачивает в трей вместо выхода.
  win.on("close", (e) => {
    try {
      if (quitting || readSettings()?.general?.closeToTray !== true) return;
      e.preventDefault();
      void hideToTray("close");
    } catch {
      /* обычное закрытие */
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

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
let updateTimer = null;
let updaterReady = false;
/** Версия скачанного, но ещё не установленного обновления (null — обновления нет). */
let pendingUpdateVersion = null;
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
  quitting = true;
  try {
    autoUpdater.quitAndInstall();
  } catch (e) {
    mlog("error", "updater.install_failed", { error: e?.message || String(e) });
  }
}

/**
 * Обязательный диалог установки. Кнопка одна, и cancelId указывает на неё же:
 * «закрыть в никуда» нельзя — любое действие (кнопка, крестик, Esc) ведёт к
 * установке. Диалог модален к главному окну: пока он открыт, окно не принимает
 * ввод, поэтому «свернуть и забыть» не получится.
 */
async function showMandatoryUpdate() {
  if (!pendingUpdateVersion || mandatoryDialogOpen) return;
  const { dialog, Notification } = require("electron");
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
  } catch (e) {
    mlog("error", "updater.dialog_failed", { error: e?.message || String(e) });
  } finally {
    mandatoryDialogOpen = false;
  }
  installUpdate();
}

function setupAutoUpdates() {
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
  } catch (e) {
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
  } catch (e) {
    return { ok: false, reason: e?.message || "error" };
  }
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  registerWindowControls();
  if (safeStorage) app.setName("MoonApp");
  mlog("info", "app.start", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
  });
  // Путь данных виден в диагностическом отчёте — сразу понятно, куда всё пишется.
  mlog("info", "app.storage", { dir: STORAGE_DIR, packaged: app.isPackaged });
  // general.autoLaunch: синхронизируем автозапуск с настройками при каждом старте.
  applyAutoLaunch();
  registerCommandPaletteHotkey();
  createWindow();
  // Проверка обновлений — после создания окна, чтобы не задерживать старт, но
  // достаточно рано: с 0.2.2 обновления обязательны, и диалог установки должен
  // появиться в начале работы, а не через минуты.
  setTimeout(() => setupAutoUpdates(), 2500);
});

app.on("before-quit", () => {
  quitting = true;
  // Остановить всё активное (компрессия/апскейл/озвучка/веб-архив) одним
  // вызовом — раньше при резком закрытии приложения дочерние процессы
  // (ffmpeg/python с TTS-моделью/whisper) могли оставаться висеть в фоне,
  // потому что ничего их централизованно не гасило (см. AUDIT_REPORT.md,
  // раздел 7). Server и Electron main — один и тот же Node-процесс
  // (см. require("../server") выше), поэтому вызов прямой и синхронный.
  try {
    require("../server/taskRegistry").killAllActive();
  } catch {
    /* сервер мог ещё не подняться — до старта убивать нечего */
  }
  try {
    if (tokenFile) fs.rmSync(tokenFile, { force: true });
  } catch {
    /* ignore */
  }
});

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
  return { ok: true };
});

// Выбрать файл через нативный диалог проводника — используется кнопкой
// "Обзор..." (страница Автоматизация: путь к программе/скрипту, и другие
// поля выбора локального файла).
ipcMain.handle("dialog:pick-file", async (_e, opts) => {
  try {
    const { dialog } = require("electron");
    const filters = Array.isArray(opts?.filters) ? opts.filters : undefined;
    const res = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters,
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Открыть внешнюю ссылку (http/https) в системном браузере по умолчанию —
// используется кликабельными ссылками в заметках/закладках.
ipcMain.handle("shell:open-external", (_e, url) => {
  try {
    const { shell } = require("electron");
    const u = String(url || "");
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: "unsupported protocol" };
    void shell.openExternal(u);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("shell:open-app-dir", () => {
  try {
    const { shell } = require("electron");
    const dir = path.dirname(STORAGE_DIR);
    void shell.openPath(dir);
    mlog("action", "shell.open_app_dir", { dir, storage: STORAGE_DIR });
    return { ok: true, dir, storageDir: STORAGE_DIR };
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
  } catch {
    return false;
  }
});

// Обновить подменю zapret в трее: страница Bypass Control вызывает после
// изменения стратегий/профилей, чтобы быстрые переключения были актуальны.
ipcMain.on("bypass:tray-refresh", () => {
  void refreshTray();
});

/* ------------------ Окно входа на форум (Cloudflare) ------------------
 * ПРОБЛЕМА: rutracker закрыт Cloudflare Bot Management — `tracker.php` и
 * `login.php` отдают страницу-проверку всем, кто не похож на браузер (проверено:
 * Node/undici получает 403 на tracker.php, хотя index.php отдаётся). Взять куки из
 * браузера пользователя тоже нельзя: Chrome/Edge 127+ шифруют их app-bound ключом
 * (v20), который доступен только самому браузеру.
 *
 * РЕШЕНИЕ: вход выполняется в Chromium САМОГО приложения. Куки остаются в его
 * session (расшифровка не нужна — их отдаёт Chromium), а прокси у окна тот же, что
 * у поиска, поэтому cf_clearance выдан тому же IP. Дальше скрапер ходит на форум
 * через сетевой стек этой же сессии (server/ts/trackerScraper.ts, chromiumSession).
 */
const TRACKER_PARTITION = "persist:moonapp-tracker";

/**
 * Кука, которой форум отмечает РЕАЛЬНЫЙ вход (rutracker: `bb_data`).
 *
 * `bb_guid`, `bb_ssl`, `bb_session` форум ставит и гостю, `bb_t` — трекинг. Если
 * считать входом их, окно закрывается сразу после проверки Cloudflare (пользователь
 * не успевает войти), а поиск уходит гостем — именно это и ломало поиск раздач.
 * Та же константа в server/ts/trackerScraper.ts (LOGIN_COOKIES).
 */
const TRACKER_LOGIN_COOKIE = "bb_data";

/**
 * UA для сессии форума: ОБЫЧНЫЙ Chrome без примет приложения.
 *
 * Зачем: у Chromium приложения по умолчанию UA вида
 * «…Chrome/126.0.6478.234 Electron/31.0.0 …» — Cloudflare считает такой отпечаток
 * ботом и отдаёт «Just a moment…» даже реальному браузеру. Собираем UA из
 * НАСТОЯЩЕЙ версии Chromium приложения, поэтому отпечаток остаётся достоверным.
 */
function trackerChromeUa() {
  const v = process.versions.chrome || "126.0.0.0";
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${v} Safari/537.36`
  );
}

/** Сессия окна входа: та же, что использует скрапер форума. */
function trackerSession() {
  return session.fromPartition(TRACKER_PARTITION);
}

/**
 * Куки форума из сессии окна входа.
 *
 * БЕРЁМ ВСЕ куки раздела и фильтруем по домену, а не запросом `{url}`: у
 * rutracker.org куки сессии (bb_data и др.) выставлены с `Path=/forum/`, поэтому
 * фильтр по URL с путём «/» их не возвращает — вход считался невыполненным.
 */
async function trackerCookies(ses, origin) {
  let list;
  try {
    list = await ses.cookies.get({});
  } catch {
    return [];
  }
  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    /* нет хоста — вернём всё, что есть */
  }
  if (!host) return list;
  return list.filter((c) => {
    const d = String(c.domain || "")
      .replace(/^\./, "")
      .toLowerCase();
    return !d || d === host || d.endsWith("." + host) || host.endsWith("." + d);
  });
}

ipcMain.handle("tracker:login-window", async (_e, opts) => {
  const url = String((opts && opts.url) || "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "bad_url" };
  const origin = new URL(url).origin;
  const ses = trackerSession();
  const rules = opts && opts.proxyRules ? String(opts.proxyRules) : null;
  // UA: либо заданный пользователем (приходит из настроек форума), либо обычный
  // Chrome от версии Chromium приложения — без «Electron/…» в отпечатке.
  const ua = String((opts && opts.userAgent) || "").trim() || trackerChromeUa();
  try {
    // Прокси тот же, что у поиска (per-page решение бэкенда) — иначе cf_clearance
    // был бы выдан другому IP и наши запросы снова получили бы проверку.
    await ses.setProxy(
      rules
        ? { mode: "fixed_servers", proxyRules: rules, proxyBypassRules: "<local>" }
        : { mode: "direct" },
    );
  } catch (e) {
    mlog("error", "tracker.login_proxy_failed", { error: e?.message || String(e) });
  }
  try {
    // Тот же UA ставим и сессии: её же сетевой стек использует скрапер
    // (session.fetch), поэтому cf_clearance, выданный окну, подходит и поиску.
    await ses.setUserAgent(ua, "ru-RU,ru;q=0.9,en;q=0.8");
  } catch (e) {
    mlog("error", "tracker.login_ua_failed", { error: e?.message || String(e) });
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 840,
    title: "Вход на форум — MoonApp",
    autoHideMenuBar: true,
    webPreferences: {
      partition: TRACKER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  return await new Promise((resolve) => {
    let settled = false;
    let poll = null;
    let lastPhase = "";
    const pick = async (reason) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      const list = await trackerCookies(ses, origin);
      const names = list.map((c) => c.name);
      // Признак РЕАЛЬНОГО входа — только bb_data: bb_guid/bb_ssl/bb_session форум
      // ставит и гостю (по ним окно закрывалось сразу после проверки Cloudflare,
      // не давая войти), bb_t — вообще трекинг.
      const loggedIn = names.includes(TRACKER_LOGIN_COOKIE);
      const hasCf = names.includes("cf_clearance");
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* уже закрыто */
      }
      mlog("action", "tracker.login_window", {
        reason,
        cookies: names.length,
        names,
        loggedIn,
        hasCf,
        ua,
        proxy: rules || "direct",
      });
      // Куки вообще не появились (Cloudflare не пропустил / вход не завершён):
      // это не «успех с пустыми куками» — UI должен сказать, что делать.
      if (!names.length) {
        resolve({ ok: false, error: "no_cookies", reason, loggedIn: false, hasCf: false });
        return;
      }
      resolve({
        ok: true,
        reason,
        loggedIn,
        hasCf,
        names,
        userAgent: ua,
        cookieHeader: list.map((c) => `${c.name}=${c.value}`).join("; "),
      });
    };

    /**
     * Ждём РЕАЛЬНОГО входа: пока в куках нет bb_data, окно не закрываем — иначе
     * пользователь не успевает пройти проверку Cloudflare и ввести логин/пароль.
     * Состояние показываем в заголовке окна (в саму страницу Cloudflare лезть
     * нельзя — это сломало бы проверку).
     */
    poll = setInterval(async () => {
      const list = await trackerCookies(ses, origin);
      const names = new Set(list.map((c) => c.name));
      if (names.has(TRACKER_LOGIN_COOKIE)) {
        void pick("logged_in");
        return;
      }
      const phase = names.has("cf_clearance") ? "cf_passed" : "challenge";
      if (phase !== lastPhase) {
        lastPhase = phase;
        mlog("info", "tracker.login_window_phase", {
          phase,
          cookies: names.size,
          hasCf: names.has("cf_clearance"),
        });
        try {
          if (!win.isDestroyed()) {
            win.setTitle(
              phase === "cf_passed"
                ? "Вход на форум — проверка пройдена, войдите (логин/пароль)"
                : "Вход на форум — пройдите проверку Cloudflare",
            );
          }
        } catch {
          /* окно уже закрыто */
        }
      }
    }, 1200);
    win.on("closed", () => void pick("closed"));
    setTimeout(() => void pick("timeout"), 15 * 60 * 1000);
    win.loadURL(url).catch(() => void pick("load_failed"));
  });
});

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
      // Окно входа на форум ходит через тот же прокси: иначе Cloudflare выдал бы
      // cf_clearance для другого IP, и поиск снова получал бы страницу-проверку.
      await trackerSession().setProxy({
        mode: "fixed_servers",
        proxyRules: rules,
        proxyBypassRules: "<local>",
      });
    } else {
      await session.defaultSession.setProxy({ mode: "direct" });
      await trackerSession().setProxy({ mode: "direct" });
    }
    mlog("action", "proxy.apply_session", { rules: rules || "direct" });
    return { ok: true, proxyRules: rules };
  } catch (e) {
    mlog("error", "proxy.apply_session_failed", { error: e?.message || String(e) });
    return { ok: false, error: e?.message || String(e) };
  }
});

/* ------------------- Системный звук (WASAPI loopback) и права -------------------
 * ПРОБЛЕМА, которую это решает: раньше «системный звук» на странице лекций
 * захватывался через navigator.mediaDevices.getDisplayMedia({video,audio}).
 * В Electron без setDisplayMediaRequestHandler это отдаёт ВИДЕО (скрин/окно),
 * а аудиодорожка либо отсутствует, либо приходит от выбранного источника —
 * пользователь получал в запись шум и «звук с камер», а не звук системы.
 *
 * РЕШЕНИЕ: Electron ≥ 31 умеет отдавать системный звук как WASAPI-loopback:
 * в обработчике display-media выбираем экран и просим audio: "loopback".
 * Тогда в поток приходит ТОЛЬКО звук устройства вывода (без видео).
 *
 * Обработчик ставится ЛЕНИВО, по IPC-запросу страницы лекций, и снимается
 * сразу после захвата — иначе он подменил бы обычный выбор экрана всем
 * остальным страницам приложения.
 */
let captureModeActive = false;

function installLoopbackHandler() {
  if (captureModeActive) return;
  captureModeActive = true;
  installMediaPermissions();
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const { desktopCapturer } = require("electron");
          const sources = await desktopCapturer.getSources({ types: ["screen"] });
          if (!sources.length) {
            callback({});
            return;
          }
          // audio: "loopback" — системный звук; видео нужно только как «носитель»
          // (страница сразу останавливает video-треки, см. acquireSystemAudio).
          callback({ video: sources[0], audio: "loopback" });
        } catch (e) {
          mlog("error", "capture.loopback_failed", { error: e?.message || String(e) });
          callback({});
        }
      },
      { useSystemPicker: false },
    );
  } catch (e) {
    // Electron < 31 или иная сборка: не роняем приложение, страница покажет
    // честную ошибку «системный звук недоступен» и предложит микрофон.
    captureModeActive = false;
    mlog("error", "capture.handler_unavailable", { error: e?.message || String(e) });
  }
}

function removeLoopbackHandler() {
  if (!captureModeActive) return;
  try {
    session.defaultSession.setDisplayMediaRequestHandler(null);
  } catch {
    /* ignore */
  }
  captureModeActive = false;
}

/**
 * Видео-захват экрана без loopback-звука — для страницы Скриншотов/записи
 * экрана. Тот же приём, что и installLoopbackHandler (обработчик ставится
 * лениво по запросу страницы и снимается сразу после), только без
 * audio:"loopback" — страница пишет либо тишину, либо (опционально)
 * микрофон отдельным getUserMedia-треком на своей стороне.
 * ОГРАНИЧЕНИЕ v1: всегда отдаётся первый найденный экран (sources[0]) —
 * полноценный выбор экрана/окна через UI не реализован ночью, честно
 * задокументировано в UI страницы.
 */
function installScreenHandler() {
  if (captureModeActive) return;
  captureModeActive = true;
  installMediaPermissions();
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const { desktopCapturer } = require("electron");
          const sources = await desktopCapturer.getSources({ types: ["screen"] });
          if (!sources.length) {
            callback({});
            return;
          }
          callback({ video: sources[0] });
        } catch (e) {
          mlog("error", "capture.screen_failed", { error: e?.message || String(e) });
          callback({});
        }
      },
      { useSystemPicker: false },
    );
  } catch (e) {
    captureModeActive = false;
    mlog("error", "capture.handler_unavailable", { error: e?.message || String(e) });
  }
}

// Режим захвата: "loopback" — системный звук (лекции), "screen" — видео экрана
// без звука (скриншоты/запись), "default" — снять обработчик.
ipcMain.handle("rec:capture-mode", (_e, mode) => {
  const m = String(mode);
  if (m === "loopback") {
    installLoopbackHandler();
    return { ok: true, mode: "loopback" };
  }
  if (m === "screen") {
    installScreenHandler();
    return { ok: true, mode: "screen" };
  }
  removeLoopbackHandler();
  return { ok: true, mode: "default" };
});

/**
 * Права на медиа. По умолчанию Electron разрешает запросы молча, но мы
 * ограничиваем их СВОИМ origin: приложение — локальный сервер на 127.0.0.1,
 * и никакой внешний контент не должен получать доступ к микрофону.
 * Ставится вместе с loopback-обработчиком (там гарантированно готов session).
 */
let permissionsInstalled = false;

function installMediaPermissions() {
  if (permissionsInstalled) return;
  permissionsInstalled = true;
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const url = String(wc?.getURL?.() || "");
      const own = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
      if (permission === "media" || permission === "display-capture") return callback(own);
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      if (permission !== "media" && permission !== "display-capture") return true;
      const origin = String(requestingOrigin || "");
      return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(origin);
    });
  } catch (e) {
    mlog("error", "capture.permissions_failed", { error: e?.message || String(e) });
  }
}

app.on("window-all-closed", () => {
  app.quit();
});

// При выходе LHM останавливается, если он был запущен этим приложением.
app.on("will-quit", () => {
  try {
    require("../server/monitor").stopLhm();
  } catch {
    /* пофиг */
  }
  globalShortcut.unregisterAll();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
