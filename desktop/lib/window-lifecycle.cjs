"use strict";

function revealMainWindow({ window, canCreate, backendReady, origin, createWindow }) {
  if (window !== null && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else if (canCreate) {
    createWindow({ revealWhenReady: true, url: backendReady ? origin : null });
  }
}

function startupWindowAvailable({ window, platform, smoke }) {
  if (window !== null && !window.isDestroyed()) return true;
  // On macOS closing the loading window leaves bootstrap running. Activation
  // can recreate it after the backend becomes ready.
  if (platform === "darwin" && !smoke) return false;
  throw new Error("The application window closed during startup.");
}

module.exports = { revealMainWindow, startupWindowAvailable };
