const { contextBridge, ipcRenderer } = require("electron");

// Токен для локального API приходит из main-процесса через временный файл
// (argv больше не используется: командная строка процесса видна всем локальным
// процессам через WMI). Файл удаляется main-процессом при выходе.
const fs = require("fs");
function readToken() {
  const arg = process.argv.find((a) => a.startsWith("--pa-token-file="));
  if (!arg) return null;
  try { return fs.readFileSync(arg.slice("--pa-token-file=".length), "utf8").trim(); }
  catch { return null; }
}

// Мост для управления фреймлесс-окном и получения инфы о системе.
contextBridge.exposeInMainWorld("appBridge", {
  version: () => process.versions.electron,
  platform: process.platform,
  // Токен подставляется в заголовок x-pa-token (см. src/api/client.ts).
  getToken: () => readToken(),
  revealPath: (p) => ipcRenderer.invoke("shell:reveal", p),
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
});
