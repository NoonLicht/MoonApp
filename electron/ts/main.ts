// ВАЖНО: порядок импортов значим (tsc сохраняет порядок require). Имя приложения
// выставляется первым (mainAppName), затем storagePath (путь к storage, env для
// серверных модулей) и только потом всё остальное, включая ../server.
import "./mainAppName";
import { app, ipcMain, BrowserWindow, session, globalShortcut } from "electron";
import { serverModule } from "./serverApi";
import fs from "fs";
import path from "path";
import { STORAGE_DIR } from "./storagePath";
import http from "http";
import crypto from "crypto";
import { ensureTray, showWindow } from "./mainTray";
import { findFreePort, mlog, patchSettings, readSettings } from "./mainCore";
import { trackerSession } from "./mainTracker";
import {
  applyAutoLaunch,
  registerCommandPaletteHotkey,
  registerOwnScreenshotHotkey,
} from "./mainHotkeys";
import { startClipboardWatch, stopClipboardWatch } from "./mainClipboard";
import { setupAutoUpdates } from "./mainUpdates";
import "./mainIpc";
import "./mainCapture";

const { startServer } = serverModule("../server");

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

// --- Трей: быстрое переключение стратегий DPI-обхода (zapret) ---
// Трей обращается к локальному API напрямую (тот же порт/токен, что у фронта).
export let apiPort: any = null;
export let apiToken: any = null;

/**
 * Скрыть окно в трей. Трей создаём ДО hide() и снимаем кнопку с панели задач:
 * иначе при закрытии/сворачивании окно остаётся висеть в таскбаре, а по клику
 * на него ничего не происходит (выглядит как зависание).
 */
async function hideToTray(reason: any) {
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
function waitForServer(port: any, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise<any>((resolve) => {
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

export let win: any = null;
// Флаг «выход по-настоящему» (через меню трея / quit): без него closeToTray
// перехватил бы и штатный выход из приложения.
export const appState = { quitting: false };

function registerWindowControls() {
  ipcMain.on("win:minimize", () => win?.minimize());
  ipcMain.on("win:toggle-maximize", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win:close", () => win?.close());

  // Перетаскивание развёрнутого окна за тулбар: у окна нет системной рамки
  // (frame: false), поэтому родное поведение Windows «тянешь заголовок
  // развёрнутого окна — оно сжимается до обычного размера под курсором» не
  // работает само по себе — см. известное ограничение Electron для
  // -webkit-app-region: drag (electron/electron#16385). Рендерер шлёт экранные
  // координаты курсора на mousedown по тулбару; если окно развёрнуто — сжимаем
  // его до предыдущего размера и подставляем позицию так, чтобы курсор остался
  // на том же относительном месте по ширине — дальше нативный drag (уже
  // начатый тем же mousedown) продолжает двигать уже нормальное окно.
  ipcMain.on("win:drag-restore", (_e, pos) => {
    if (!win || !win.isMaximized()) return;
    const maxBounds = win.getBounds();
    win.unmaximize();
    const restored = win.getBounds();
    const x = Number(pos?.x);
    const y = Number(pos?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || maxBounds.width <= 0) return;
    const ratio = (x - maxBounds.x) / maxBounds.width;
    const newX = Math.round(x - ratio * restored.width);
    const newY = Math.max(0, Math.round(y - 10));
    win.setBounds({ x: newX, y: newY, width: restored.width, height: restored.height });
  });
}

async function createWindow() {
  // Токен на одну сессию, чтобы сторонние запросы к локальному API не проходили.
  // Ни в argv (виден другим процессам через WMI), ни в файле он не передаётся:
  // preload получает его синхронным IPC app:get-token (см. ниже).
  const token = crypto.randomBytes(24).toString("hex");

  const port = await findFreePort();
  startServer(port, { token });
  // Скрапер форума ходит на rutracker сетевым стеком ЭТОЙ сессии: настоящие
  // TLS/HTTP2-отпечатки и те же куки, что прошли Cloudflare в окне входа
  // (server/ts/trackerScraper.ts → bindChromiumSession). Ошибка привязки не
  // критична: тогда поиск пойдёт обычным fetch с per-page прокси.
  try {
    serverModule("../server/trackerScraper").bindChromiumSession(trackerSession());
  } catch (e: any) {
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
      const { screen } = require("electron") as typeof import("electron");
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
      // preload не использует Node API (только contextBridge/ipcRenderer), поэтому
      // песочница включена: компрометация renderer не даёт доступа к fs/child_process.
      sandbox: true,
    },
  });

  // Токен отдаём только окну приложения, загруженному с локального сервера:
  // чужой фрейм/страница (например, окно входа на форум) его не получит.
  ipcMain.removeAllListeners("app:get-token");
  ipcMain.on("app:get-token", (event) => {
    const trusted =
      !!win &&
      event.sender === win.webContents &&
      String(event.senderFrame?.url || "").startsWith(`http://127.0.0.1:${port}/`);
    event.returnValue = trusted ? token : null;
  });

  // Токен теперь нужен и для статики/навигации (server/ts/index.ts →
  // authMiddleware), а не только для fetch() из renderer. Сам renderer не может
  // проставить заголовок на запрос загрузки страницы (win.loadURL) или её
  // подресурсов (JS/CSS), поэтому подставляем его здесь, на уровне сессии —
  // любой сторонний браузер, открывший http://127.0.0.1:<port> напрямую,
  // этот перехватчик не затрагивает и получит 401.
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`http://127.0.0.1:${port}/*`] },
    (details: any, cb: any) => {
      details.requestHeaders["x-moonapp-token"] = token;
      cb({ requestHeaders: details.requestHeaders });
    },
  );

  // CSP: даже если чужой HTML/Markdown пробьёт санитайзер — инлайн-скрипты
  // и внешние загрузки запрещены. Собственный бандл — 'self'.
  win.webContents.session.webRequest.onHeadersReceived((details: any, cb: any) => {
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
  win.on("close", (e: any) => {
    try {
      if (appState.quitting || readSettings()?.general?.closeToTray !== true) return;
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

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  registerWindowControls();
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
  registerOwnScreenshotHotkey();
  createWindow();
  startClipboardWatch();
  // Проверка обновлений — после создания окна, чтобы не задерживать старт, но
  // достаточно рано: с 0.2.2 обновления обязательны, и диалог установки должен
  // появиться в начале работы, а не через минуты.
  setTimeout(() => setupAutoUpdates(), 2500);
});

app.on("before-quit", () => {
  appState.quitting = true;
  stopClipboardWatch();
  // Остановить всё активное (компрессия/апскейл/озвучка/веб-архив) одним
  // вызовом — раньше при резком закрытии приложения дочерние процессы
  // (ffmpeg/python с TTS-моделью/whisper) могли оставаться висеть в фоне,
  // потому что ничего их централизованно не гасило (см. AUDIT_REPORT.md,
  // раздел 7). Server и Electron main — один и тот же Node-процесс
  // (см. require("../server") выше), поэтому вызов прямой и синхронный.
  try {
    serverModule("../server/taskRegistry").killAllActive();
  } catch {
    /* сервер мог ещё не подняться — до старта убивать нечего */
  }
});

/**
 * Права на медиа. По умолчанию Electron разрешает запросы молча, но мы
 * ограничиваем их СВОИМ origin: приложение — локальный сервер на 127.0.0.1,
 * и никакой внешний контент не должен получать доступ к микрофону.
 * Ставится вместе с loopback-обработчиком (там гарантированно готов session).
 */
let permissionsInstalled = false;

export function installMediaPermissions() {
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
      if ((permission as string) !== "media" && (permission as string) !== "display-capture")
        return true;
      const origin = String(requestingOrigin || "");
      return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(origin);
    });
  } catch (e: any) {
    mlog("error", "capture.permissions_failed", { error: e?.message || String(e) });
  }
}

app.on("window-all-closed", () => {
  app.quit();
});

// При выходе LHM останавливается, если он был запущен этим приложением.
app.on("will-quit", () => {
  try {
    serverModule("../server/monitor").stopLhm();
  } catch {
    /* пофиг */
  }
  globalShortcut.unregisterAll();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
