const { contextBridge, ipcRenderer } = require("electron");

// Токен для локального API приходит из main-процесса через additionalArguments.
const tokenArg = process.argv.find((a) => a.startsWith("--pa-token="));

// Мост для управления фреймлесс-окном и получения инфы о системе.
contextBridge.exposeInMainWorld("appBridge", {
  version: () => process.versions.electron,
  platform: process.platform,
  // Токен подставляется в заголовок x-pa-token (см. src/api/client.ts).
  getToken: () => (tokenArg ? tokenArg.slice("--pa-token=".length) : null),
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
});
