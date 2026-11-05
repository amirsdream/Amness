// Finding text in the conversation (ctrl+f) and file paths in replies (click to open). Pure functions over plain rendered rows.
import { basename } from "node:path";
import { cellWidth } from "./text.ts";

export type FindHit = { /** row in the whole transcript */ row: number; /** first column */ col: number; /** columns it covers */ w: number };

/** Every place `q` occurs in the rows (case-insensitive), top to bottom. */
export function findRows(rows: string[], q: string): FindHit[] {
  if (!q) return [];
  const needle = q.toLowerCase(), out: FindHit[] = [];
  rows.forEach((text, row) => {
    const hay = text.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push({ row, col: cellWidth(text.slice(0, i)), w: cellWidth(text.slice(i, i + needle.length)) });
  });
  return out;
}

/** `src/app.ts`, `./a/b.js:12`, `README.md:3:7` in a row of text: where each sits and what it names. `exists` decides which are real files. */
export function filesIn(text: string, exists: (path: string) => boolean): { a: number; b: number; path: string; line?: number }[] {
  const out: { a: number; b: number; path: string; line?: number }[] = [];
  for (const m of text.matchAll(/(?<![\w./@:-])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?::\d+)?)?(?![\w/])/g)) {
    const path = m[1]; if (/^\d+(\.\d+)+$/.test(path) || !exists(path)) continue;                     // a version number is not a file
    out.push({ a: m.index!, b: m.index! + m[0].length, path, line: m[2] ? Number(m[2]) : undefined });
  }
  return out;
}

/** How to open `file` at `line` in the user's editor. `terminal` editors take over the screen (the chat steps aside); others open in their own window. */
export function fileOpenCommand(editor: string, file: string, line = 1, platform = process.platform): { cmd: string; terminal: boolean } {
  const q = JSON.stringify(file), name = basename(editor.trim().split(/\s+/)[0] ?? "").replace(/\.exe$/i, "").toLowerCase();
  if (!editor.trim()) return { cmd: platform === "darwin" ? `open ${q}` : platform === "win32" ? `start "" ${q}` : `xdg-open ${q}`, terminal: false };
  if (/^(code|code-insiders|cursor|codium|vscodium|windsurf)$/.test(name)) return { cmd: `${editor} -g ${JSON.stringify(`${file}:${line}`)}`, terminal: false };
  if (/^(zed|subl|sublime_text|mate)$/.test(name)) return { cmd: `${editor} ${JSON.stringify(`${file}:${line}`)}`, terminal: false };
  if (/^(idea|webstorm|pycharm|goland|clion|rider|phpstorm|rubymine|studio)$/.test(name)) return { cmd: `${editor} --line ${line} ${q}`, terminal: false };
  return { cmd: `${editor} +${line} ${q}`, terminal: true };                                              // vi, vim, nvim, nano, emacs, hx, micro, kak all take +N
}
