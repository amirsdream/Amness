// Things the chat borrows from the rest of the system: the user's own text editor (ctrl+g) and an image on the clipboard (ctrl+v).
// Both are plain functions with no terminal state, so the App decides when to give the terminal away and take it back.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The editor command the user chose: $VISUAL, then $EDITOR, else a safe default for the platform. */
export const editorCommand = (env: NodeJS.ProcessEnv = process.env): string => env.VISUAL || env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");

/** Open `text` in the user's editor and wait for it to close. Returns the saved text (one trailing newline removed), or undefined if the editor failed to start or exited with an error. */
export function editExternally(text: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "amness-edit-")), file = join(dir, "message.md");
  try {
    writeFileSync(file, text);
    // The command may carry arguments ("code --wait"), so it goes through the shell; the file name is quoted.
    const r = spawnSync(`${editorCommand(env)} ${JSON.stringify(file)}`, { stdio: "inherit", shell: true, env });
    if (r.error || r.status !== 0) return undefined;
    return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir: the OS cleans it */ } }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const run = (cmd: string, args: string[]) => { try { const r = spawnSync(cmd, args, { encoding: "buffer", timeout: 5000, maxBuffer: 50 << 20 }); return r.status === 0 ? r.stdout : undefined; } catch { return undefined; } };

/** The image on the system clipboard as PNG bytes, or undefined when there is none (or no tool to read it). macOS: osascript; Wayland: wl-paste; X11: xclip; Windows: PowerShell. */
export function readClipboardImage(): Buffer | undefined {
  let buf: Buffer | undefined;
  if (process.platform === "darwin") {
    const out = run("osascript", ["-e", "the clipboard as «class PNGf»"])?.toString("utf8") ?? "";
    const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(out)?.[1]; if (hex) buf = Buffer.from(hex, "hex");
  } else if (process.platform === "win32") {
    const tmp = join(mkdtempSync(join(tmpdir(), "amness-clip-")), "clip.png");
    run("powershell.exe", ["-NoProfile", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`]);
    try { buf = readFileSync(tmp); } catch { /* no image */ }
  } else buf = process.env.WAYLAND_DISPLAY ? run("wl-paste", ["--no-newline", "--type", "image/png"]) : run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
  return buf && buf.subarray(0, 4).equals(PNG) ? buf : undefined;
}

/** Save pasted image bytes inside the project (mentions only read files there) and return the path to mention, relative to `cwd`. */
export function savePastedImage(cwd: string, png: Buffer, now = new Date()): string {
  const rel = join(".amness", "paste", `clip-${now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${Math.random().toString(36).slice(2, 6)}.png`);
  mkdirSync(join(cwd, ".amness", "paste"), { recursive: true }); writeFileSync(join(cwd, rel), png);
  return rel.split("\\").join("/");
}
