// Renders the desktop app icon (cli/desktop/assets/icon.svg) to the PNGs Electron uses: run with `npx electron scripts/desktop-icons.cjs`.
// Electron draws the SVG in an offscreen window with a transparent background, so no image tools are needed.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const dir = path.join(__dirname, "..", "cli", "desktop", "assets");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html," + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const full = img.getSize().width === 1024 ? img : img.resize({ width: 1024, height: 1024 });
  fs.writeFileSync(path.join(dir, "icon.png"), full.toPNG());
  for (const s of [512, 256]) fs.writeFileSync(path.join(dir, `icon-${s}.png`), full.resize({ width: s, height: s, quality: "best" }).toPNG());
  console.log("wrote", fs.readdirSync(dir).filter((f) => f.endsWith(".png")).join(", "));
  app.quit();
});
