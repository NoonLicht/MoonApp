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
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  pickFile: (opts) => ipcRenderer.invoke("dialog:pick-file", opts),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
  // Открыть каталог установки приложения (кнопка в верхней панели).
  openAppDir: () => ipcRenderer.invoke("shell:open-app-dir"),
  refreshTray: () => ipcRenderer.send("bypass:tray-refresh"),
  // Автозапуск с Windows: применить настройку СРАЗУ (реестр Run правит main-процесс).
  // Без этого галочка в «Настройках» работала бы только после перезапуска приложения.
  // Ответ: { ok, openAtLogin, reason? } — reason: "dev" в не-собранной версии.
  applyAutoLaunch: () => ipcRenderer.invoke("app:autolaunch"),
  // Встроенный прокси: применить ({ proxyRules: "socks5://127.0.0.1:10808" })
  // или снять (null) глобальный прокси Chromium (session.defaultSession).
  applyProxySession: (cfg) => ipcRenderer.invoke("proxy:apply-session", cfg),
  // Окно входа на форум: открывает Chromium приложения на странице входа и, когда
  // пользователь РЕАЛЬНО вошёл (в куках появился bb_data), возвращает куки сессии:
  //   { ok, loggedIn, hasCf, names, cookieHeader, userAgent, reason }
  // Нужно для Cloudflare-проверки (см. electron/main.js → tracker:login-window).
  openTrackerLogin: (opts) => ipcRenderer.invoke("tracker:login-window", opts),
  // Режим захвата звука: "loopback" — системный звук (WASAPI), "screen" — видео
  // экрана/окна (sourceId — id из listCaptureSources), "default" — обычный.
  // Нужен странице лекций: без него getDisplayMedia отдаёт видео/камеру, а не звук системы.
  setCaptureMode: (mode, sourceId) => ipcRenderer.invoke("rec:capture-mode", mode, sourceId),
  // Список экранов/окон (с превью) для выбора источника захвата (страница «Скриншоты»).
  listCaptureSources: () => ipcRenderer.invoke("capture:list-sources"),
  // Обновления приложения (работают только в packaged-сборке). Обновления
  // обязательны (0.2.2): проверка идёт при старте и каждые 4 часа, установка —
  // через обязательный диалог. Выключателя (updates:toggle) больше нет.
  checkUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  // Глобальный хоткей Alt+Space (командная палитра): вызывается со страницы
  // настроек сразу после смены general.commandPaletteHotkey — main-процесс
  // перечитывает settings.json и перерегистрирует/снимает шорткат без
  // перезапуска приложения.
  refreshHotkey: () => ipcRenderer.invoke("app:refresh-hotkey"),
  // Подписка на событие "открыть палитру" (Alt+Space нажат где угодно в ОС).
  // Возвращает функцию отписки — вызывающий код обязан её сохранить и дёрнуть
  // на unmount, иначе на каждый ремонт компонента копится ещё один слушатель.
  onOpenPalette: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("app:open-palette", listener);
    return () => ipcRenderer.removeListener("app:open-palette", listener);
  },
});
