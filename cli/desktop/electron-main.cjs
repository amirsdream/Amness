// Electron main process for `amness-desktop`. It is only a window: the agent runs in the Node process that started it (cli/desktop.ts),
// which passes the local address in AMNESS_DESKTOP_URL, or (AMNESS_DESKTOP_WAIT) starts this first and sends {url, title} as one line on stdin
// once its server is up, so the window and its start screen (ui/splash.html) appear at once. The page runs sandboxed with no Node access.
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, session, shell } = require("electron");
const path = require("node:path");

let target = process.env.AMNESS_DESKTOP_URL, origin = target ? new URL(target).origin : undefined;
const waiting = !target && !!process.env.AMNESS_DESKTOP_WAIT;
if (!target && !waiting) { console.error("amness-desktop: start it with the amness-desktop command"); process.exit(2); }
/** The address, once the Node process has sent it (only when waiting). */
const address = waiting ? new Promise((res) => {
  let buf = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i < 0) return; try { const m = JSON.parse(buf.slice(0, i)); if (typeof m.url === "string" && (/^http:\/\/127\.0\.0\.1:\d+\//.test(m.url) || (process.env.AMNESS_DESKTOP_REMOTE === "1" && /^https?:\/\/[^/\s]+\//.test(m.url)))) res(m); } catch { /* not ours */ } });
  process.stdin.on("end", () => app.quit());                                                 // the Node process went away before the server was up
}) : Promise.resolve({ url: target });
const ICON = path.join(__dirname, "assets", "icon.png");                                      // the app icon: window, taskbar, dock
const SIZE = (process.env.AMNESS_DESKTOP_SIZE || "1440x920").split("x").map(Number);              // a check can ask for a smaller window
app.setName("Amness");
app.setAboutPanelOptions?.({ applicationName: "Amness", iconPath: path.join(__dirname, "assets", "icon.png") });

function openExternal(u) { try { const p = new URL(u); if (p.protocol === "https:" || p.protocol === "http:") void shell.openExternal(p.href); } catch { /* not a URL */ } }

function createWindow() {
  const win = new BrowserWindow({
    width: SIZE[0], height: SIZE[1], minWidth: 640, minHeight: 480, title: process.env.AMNESS_DESKTOP_TITLE || "Amness", show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1116" : "#f7f8fa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default", trafficLightPosition: { x: 14, y: 14 },
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, "electron-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: true },
  });
  win.once("ready-to-show", () => win.show());                                               // the start screen is a local page, so this comes at once
  if (process.env.AMNESS_DESKTOP_EVAL) {                                                      // for automated UI checks: run a script in the page, print its result, quit
    win.webContents.once("did-finish-load", async () => {
      let out; try { out = await win.webContents.executeJavaScript(require("node:fs").readFileSync(process.env.AMNESS_DESKTOP_EVAL, "utf8")); } catch (e) { out = { error: String(e && e.message || e) }; }
      if (process.env.AMNESS_DESKTOP_SCREENSHOT) require("node:fs").writeFileSync(process.env.AMNESS_DESKTOP_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      process.stdout.write("AMNESS_EVAL " + JSON.stringify(out) + "\n"); app.quit();
    });
  } else if (process.env.AMNESS_DESKTOP_SCREENSHOT) {                                                // for docs and checks: save a picture of the window once it has settled, then quit
    win.webContents.once("did-finish-load", () => setTimeout(async () => { require("node:fs").writeFileSync(process.env.AMNESS_DESKTOP_SCREENSHOT, (await win.webContents.capturePage()).toPNG()); app.quit(); }, Number(process.env.AMNESS_DESKTOP_SCREENSHOT_MS || 2500)));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!origin || new URL(url).origin !== origin) { e.preventDefault(); openExternal(url); } });
  if (waiting) {
    void win.loadFile(path.join(__dirname, "ui", "splash.html"));
    void address.then((m) => { target = m.url; origin = new URL(m.url).origin; if (m.title) win.setTitle(String(m.title)); void win.loadURL(target); });
  } else void win.loadURL(target);
  return win;
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) try { app.dock.setIcon(ICON); } catch { /* icon missing: the default stays */ }
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));     // no camera, microphone, location or notifications prompts from the page
  ipcMain.handle("amness:pick-folder", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: "Open a project folder", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle("amness:notify", (e, title, body) => {                                     // a long turn ended or approval is needed while the window is in the background
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 300), silent: false });
    n.on("click", () => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
    n.show();
  });
  ipcMain.handle("amness:reveal", (_e, p) => { if (typeof p === "string" && path.isAbsolute(p)) shell.showItemInFolder(p); });
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: "Amness", submenu: [{ role: "about" }, { type: "separator" }, { label: "Preferences…", accelerator: "Cmd+,", click: (_m, w) => w?.webContents.send("amness:menu", "prefs") }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    { label: "File", submenu: [
      { label: "New Conversation", accelerator: "CmdOrCtrl+N", click: (_m, w) => w?.webContents.send("amness:menu", "new") },
      { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: (_m, w) => w?.webContents.send("amness:menu", "open") },
      { label: "Go to File…", accelerator: "CmdOrCtrl+P", click: (_m, w) => w?.webContents.send("amness:menu", "file") },
      ...(isMac ? [] : [{ type: "separator" }, { label: "Preferences…", accelerator: "Ctrl+,", click: (_m, w) => w?.webContents.send("amness:menu", "prefs") }]),
      { type: "separator" }, isMac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: (_m, w) => w?.webContents.send("amness:menu", "sidebar") },
      { label: "Toggle Workspace Panel", accelerator: "CmdOrCtrl+J", click: (_m, w) => w?.webContents.send("amness:menu", "panel") },
      { label: "Expand All Tool Output", accelerator: "CmdOrCtrl+E", click: (_m, w) => w?.webContents.send("amness:menu", "expand") },
      { label: "Find in Conversation", accelerator: "CmdOrCtrl+F", click: (_m, w) => w?.webContents.send("amness:menu", "find") },
      { label: "Command Palette", accelerator: "CmdOrCtrl+K", click: (_m, w) => w?.webContents.send("amness:menu", "palette") },
      { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
      ...(process.env.AMNESS_DESKTOP_DEVTOOLS ? [{ role: "toggleDevTools" }] : []),
    ] },
    { role: "windowMenu" },
  ]));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => app.quit());
