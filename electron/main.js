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

  // Окно полупрозрачное и без системной рамки.
  // Вся матовость — из CSS (blur-фильтры и цвета).
  win = new BrowserWindow({
    width: 1180,
    height: 820,
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

  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  registerWindowControls();
  if (safeStorage) app.setName("PersonalApp");
  createWindow();
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