"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "scopeX",
  Object.freeze({
    status: () => ipcRenderer.invoke("scope:x", "status"),
    connect: () => ipcRenderer.invoke("scope:x", "connect"),
    cancel: () => ipcRenderer.invoke("scope:x", "cancel"),
    disconnect: () => ipcRenderer.invoke("scope:x", "disconnect"),
    focus: () => ipcRenderer.invoke("scope:x", "focus"),
    "retry-storage": () => ipcRenderer.invoke("scope:x", "retry-storage"),
  }),
);
contextBridge.exposeInMainWorld(
  "scopeApp",
  Object.freeze({
    info: () => ipcRenderer.invoke("scope:app", "info"),
    openLogs: () => ipcRenderer.invoke("scope:app", "open-logs"),
    integrationStatus: () => ipcRenderer.invoke("scope:app", "integration-status"),
    installMenuEntry: () => ipcRenderer.invoke("scope:app", "install-menu-entry"),
    removeMenuEntry: () => ipcRenderer.invoke("scope:app", "remove-menu-entry"),
  }),
);
