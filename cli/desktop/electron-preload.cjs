// The only bridge between the page and Electron: a native folder picker, "show in folder", and the app menu's commands. No Node, no file access.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("amnessDesktop", {
  pickFolder: () => ipcRenderer.invoke("amness:pick-folder"),
  reveal: (absPath) => ipcRenderer.invoke("amness:reveal", absPath),
  notify: (title, body) => ipcRenderer.invoke("amness:notify", title, body),
  onMenu: (fn) => { ipcRenderer.on("amness:menu", (_e, what) => fn(String(what))); },
});
