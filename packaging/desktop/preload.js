const { contextBridge, ipcRenderer } = require("electron");
const DESKTOP_LAUNCHER_BRIDGE_PATHS = new Set([
  "/enter",
  "/login"
]);

ipcRenderer.on("space-desktop:update-status", (_event, payload) => {
  window.dispatchEvent(new CustomEvent("space-desktop:update-status", {
    detail: payload
  }));
});

const debugReinstall = (version = "") => ipcRenderer.invoke("space-desktop:debug-reinstall", {
  version
});

if (DESKTOP_LAUNCHER_BRIDGE_PATHS.has(globalThis.location?.pathname || "")) {
  contextBridge.exposeInMainWorld("space", {
    platform: process.platform,
    getRuntimeInfo: () => ipcRenderer.invoke("space-desktop:get-runtime-info"),
    checkForUpdates: () => ipcRenderer.invoke("space-desktop:check-for-updates"),
    downloadUpdate: () => ipcRenderer.invoke("space-desktop:download-update"),
    installUpdate: () => ipcRenderer.invoke("space-desktop:install-update"),
    debugReinstall
  });
}
