import { contextBridge, ipcRenderer } from "electron";

// Окно работает в песочнице (sandbox: true): preload не может читать файлы, поэтому
// токен локального API запрашивается у main-процесса синхронным IPC. Main отвечает
// только окну приложения, загруженному с локального сервера (см. app:get-token).
// Мост для управления фреймлесс-окном и получения инфы о системе.
contextBridge.exposeInMainWorld("appBridge", {
  version: () => process.versions.electron,
  platform: process.platform,
  // Токен подставляется в заголовок x-moonapp-token (см. src/api/client.ts).
  getToken: () => ipcRenderer.sendSync("app:get-token") as string | null,
  revealPath: (p: any) => ipcRenderer.invoke("shell:reveal", p),
  openExternal: (url: any) => ipcRenderer.invoke("shell:open-external", url),
  pickFile: (opts: any) => ipcRenderer.invoke("dialog:pick-file", opts),
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
  applyProxySession: (cfg: any) => ipcRenderer.invoke("proxy:apply-session", cfg),
  // Окно входа на форум: открывает Chromium приложения на странице входа и, когда
  // пользователь РЕАЛЬНО вошёл (в куках появился bb_data), возвращает куки сессии:
  //   { ok, loggedIn, hasCf, names, cookieHeader, userAgent, reason }
  // Нужно для Cloudflare-проверки (см. electron/main.js → tracker:login-window).
  openTrackerLogin: (opts: any) => ipcRenderer.invoke("tracker:login-window", opts),
  // Режим захвата звука: "loopback" — системный звук (WASAPI), "screen" — видео
  // экрана/окна (sourceId — id из listCaptureSources), "default" — обычный.
  // Нужен странице лекций: без него getDisplayMedia отдаёт видео/камеру, а не звук системы.
  setCaptureMode: (mode: any, sourceId: any) =>
    ipcRenderer.invoke("rec:capture-mode", mode, sourceId),
  // Список экранов/окон (с превью) для выбора источника захвата (страница «Скриншоты»).
  listCaptureSources: () => ipcRenderer.invoke("capture:list-sources"),
  // Резервный захват системного звука на Linux (PulseAudio/PipeWire parec/pw-record),
  // на случай если portal-путь Chromium не дал звука. На Windows — no-op.
  startLinuxSystemAudioFallback: () => ipcRenderer.invoke("audio:linux-fallback-start"),
  stopLinuxSystemAudioFallback: () => ipcRenderer.invoke("audio:linux-fallback-stop"),
  // Вызывается сразу после того, как страница сама записала картинку в буфер
  // обмена (кнопка «Скопировать») — иначе вотчер буфера (автосохранение
  // PrintScreen/Win+Shift+S в библиотеку) принял бы её за новый внешний
  // скриншот и задвоил бы библиотеку тем же кадром.
  clipboardMarkSeen: () => ipcRenderer.invoke("clipboard:mark-seen"),
  // Обновления приложения (работают только в packaged-сборке). Обновления
  // обязательны (0.2.2): проверка идёт при старте и каждые 4 часа, установка —
  // через обязательный диалог. Выключателя (updates:toggle) больше нет.
  checkUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  // Прозрачное окно: акриловая подложка Windows 11 (сквозь окно виден рабочий стол).
  setTransparent: (on: boolean) => ipcRenderer.send("win:set-transparent", !!on),
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  dragStart: () => ipcRenderer.send("win:drag-start"),
  dragEnd: () => ipcRenderer.send("win:drag-end"),
  // Глобальный хоткей Alt+Space (командная палитра): вызывается со страницы
  // настроек сразу после смены general.commandPaletteHotkey — main-процесс
  // перечитывает settings.json и перерегистрирует/снимает шорткат без
  // перезапуска приложения.
  refreshHotkey: () => ipcRenderer.invoke("app:refresh-hotkey"),
  // Отдельные окна страниц на выбранном мониторе.
  listDisplays: () => ipcRenderer.invoke("win:list-displays"),
  openPageWindow: (pageId: string, displayId?: number, opts?: { widget?: boolean }) =>
    ipcRenderer.invoke("win:open-page", pageId, displayId, opts),
  // Режим «чужой за столом»: глобальная клавиша из main → renderer, и обратная синхронизация заголовка.
  onPrivacy: (cb: any) => {
    const listener = (_e: unknown, on: boolean) => cb(on);
    ipcRenderer.on("app:privacy", listener);
    return () => ipcRenderer.removeListener("app:privacy", listener);
  },
  privacySet: (on: boolean) => ipcRenderer.invoke("app:privacy-set", on),
  // Подписка на событие "открыть палитру" (Alt+Space нажат где угодно в ОС).
  // Возвращает функцию отписки — вызывающий код обязан её сохранить и дёрнуть
  // на unmount, иначе на каждый ремонт компонента копится ещё один слушатель.
  onOpenPalette: (cb: any) => {
    const listener = () => cb();
    ipcRenderer.on("app:open-palette", listener);
    return () => ipcRenderer.removeListener("app:open-palette", listener);
  },
});
