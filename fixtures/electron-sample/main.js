const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
const path = require("path");
function createWindow() {
  const win = new BrowserWindow({ width: 900, height: 600, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false } });
  win.loadFile("index.html");
}
ipcMain.handle("clipboard:read", () => clipboard.readText());
ipcMain.on("app:quit", () => app.quit());
app.whenReady().then(createWindow);
