const { contextBridge, ipcRenderer } = require("electron");

// Токен для локального API приходит из main-процесса через временный файл
// (argv больше не используется: командная строка процесса видна всем локальным
// процессам через WMI). Файл удаляется main-процессом при выходе.
const fs = require("fs");
function readToken() {
  const arg = process.argv.find((a) => a.startsWith("--moonapp-token-file="));
  if (!arg) return null;
  try {
    return fs.readFileSync(arg.slice("--moonapp-token-file=".length), "utf8").trim();
  } catch {
    return null;
  }
}

// Мост для управления фреймлесс-окном и получения инфы о системе.
contextBridge.exposeInMainWorld("appBridge", {
  version: () => process.versions.electron,
  platform: process.platform,
  // Токен подставляется в заголовок x-moonapp-token (см. src/api/client.ts).
  getToken: () => readToken(),
  revealPath: (p) => ipcRenderer.invoke("shell:reveal", p),
  // Открыть каталог установки приложения (кнопка в верхней панели).
  openAppDir: () => ipcRenderer.invoke("shell:open-app-dir"),
  refreshTray: () => ipcRenderer.send("bypass:tray-refresh"),
  // Встроенный прокси: применить ({ proxyRules: "socks5://127.0.0.1:10808" })
  // или снять (null) глобальный прокси Chromium (session.defaultSession).
  applyProxySession: (cfg) => ipcRenderer.invoke("proxy:apply-session", cfg),
  // Режим захвата звука: "loopback" — системный звук (WASAPI), "default" — обычный.
  // Нужен странице лекций: без него getDisplayMedia отдаёт видео/камеру, а не звук системы.
  setCaptureMode: (mode) => ipcRenderer.invoke("rec:capture-mode", mode),
  // Обновления приложения (работают только в packaged-сборке). Обновления
  // обязательны (0.2.2): проверка идёт при старте и каждые 4 часа, установка —
  // через обязательный диалог. Выключателя (updates:toggle) больше нет.
  checkUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
});
