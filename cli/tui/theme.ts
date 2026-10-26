// Colour system for the chat UI: truecolor when the terminal has it, 256/16 colours otherwise, plain text under NO_COLOR or when piped.
export type RGB = [number, number, number];

export function detectLevel(env: Record<string, string | undefined> = process.env, tty = !!process.stdout.isTTY): 0 | 1 | 2 | 3 {
  if (env.NO_COLOR) return 0;
  const f = env.FORCE_COLOR;
  if (f !== undefined && f !== "") return f === "0" || f === "false" ? 0 : f === "2" ? 2 : f === "3" ? 3 : 1;
  if (!tty) return 0;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "") || /^(iTerm\.app|vscode|WezTerm|Hyper|ghostty)$/i.test(env.TERM_PROGRAM ?? "") || /kitty|alacritty/i.test(env.TERM ?? "")) return 3;   // Apple Terminal is 256-colour only
  if (/256/.test(env.TERM ?? "")) return 2;
  return 1;
}
export let level = detectLevel();
/** Tests (and `--color` style flags) can override detection. */
export const setLevel = (l: 0 | 1 | 2 | 3) => { level = l; };

const to256 = ([r, g, b]: RGB) => {
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) { const v = Math.round(((r + g + b) / 3 - 8) / 10); return v < 0 ? 16 : v > 23 ? 231 : 232 + v; }   // greys
  const c = (x: number) => Math.round((x / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
};
const to16 = ([r, g, b]: RGB) => {
  const bright = Math.max(r, g, b) > 200, idx = (r > 127 ? 1 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 4 : 0);
  return (bright ? 90 : 30) + (idx === 0 && !bright ? 7 : idx);
};

/** Foreground colour; resets only the foreground so bold/dim keep working around it. */
export function fg(c: RGB, s: string): string {
  if (!level || !s) return s;
  return level === 3 ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m` : level === 2 ? `\x1b[38;5;${to256(c)}m${s}\x1b[39m` : `\x1b[${to16(c)}m${s}\x1b[39m`;
}
export const bold = (s: string) => (level ? `\x1b[1m${s}\x1b[22m` : s);
export const dimmed = (s: string) => (level ? `\x1b[2m${s}\x1b[22m` : s);

export const lerp = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
/** Colour at position t∈[0,1] along a multi-stop gradient. */
export function at(stops: RGB[], t: number): RGB {
  if (stops.length === 1) return stops[0];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x));
  return lerp(stops[i], stops[i + 1], x - i);
}
/** Paint each character along a gradient (a single colour at low colour depth, so it stays readable). */
export function gradient(text: string, stops: RGB[], phase = 0): string {
  if (level < 2) return fg(stops[Math.floor(stops.length / 2)], text);
  const chars = [...text], n = Math.max(1, chars.length - 1);
  return chars.map((ch, i) => (ch === " " ? ch : fg(at(stops, ((i / n) + phase) % 1), ch))).join("");
}

export const palette = {
  brand: [[124, 92, 255], [0, 180, 255], [0, 229, 160]] as RGB[],            // violet → blue → mint
  claude: [217, 119, 87] as RGB, openai: [16, 163, 127] as RGB, local: [154, 165, 177] as RGB, other: [138, 180, 248] as RGB,
  read: [91, 157, 255] as RGB, edit: [255, 180, 84] as RGB, shell: [199, 146, 234] as RGB, web: [77, 208, 225] as RGB,
  memory: [126, 231, 135] as RGB, plan: [255, 121, 198] as RGB, explore: [255, 158, 100] as RGB, generic: [160, 174, 192] as RGB,
  ok: [86, 211, 100] as RGB, warn: [255, 196, 0] as RGB, err: [255, 85, 85] as RGB, muted: [110, 118, 129] as RGB,
  gauge: [[63, 220, 140], [255, 200, 60], [255, 85, 85]] as RGB[],
};

const CATEGORY: Record<string, RGB> = {
  read_file: palette.read, list_files: palette.read, grep: palette.read, memory_search: palette.read,
  write_file: palette.edit, edit_file: palette.edit, sh: palette.shell, web_search: palette.web, fetch_url: palette.web,
  memory_save: palette.memory, memory_forget: palette.memory, todo_write: palette.plan, exit_plan_mode: palette.plan, task: palette.explore,
};
export const toolColor = (name: string): RGB => CATEGORY[name] ?? (name.includes("__") ? palette.web : palette.generic);

/** Provider/model identity: a glyph and an accent colour. */
export function brandOf(model: string, provider = ""): { icon: string; color: RGB } {
  if (/claude|fable|mythos/i.test(model) || provider === "anthropic") return { icon: "✻", color: palette.claude };
  if (/gpt|o[134]-|openai|chatgpt/i.test(model) || provider === "openai") return { icon: "◈", color: palette.openai };
  if (/llama|qwen|mistral|gemma|phi|deepseek|ollama/i.test(model) || provider === "ollama") return { icon: "⬢", color: palette.local };
  return { icon: "◆", color: palette.other };
}

// ---------------------------------------------------------------- token meters
/** ▰▰▰▱▱▱▱▱ context gauge. Filled cells shift green → amber → red the fuller the window gets. */
export function gauge(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, pct)), filled = Math.round((p / 100) * width);
  let s = "";
  for (let i = 0; i < width; i++) {
    if (i < filled) s += level >= 2 ? fg(at(palette.gauge, (i + 0.5) / width), "▰") : fg(p > 85 ? palette.err : p > 60 ? palette.warn : palette.ok, "▰");    // a cell's colour is its place on the bar, so a low gauge stays green
    else s += fg(palette.muted, "▱");
  }
  return s;
}
export const gaugeColor = (pct: number): RGB => (pct > 85 ? palette.err : pct > 60 ? palette.warn : palette.ok);

const BARS = "▁▂▃▄▅▆▇█";
/** Tiny bar chart of the last `width` values. */
export function sparkline(values: number[], width = 12, color: RGB = palette.brand[1]): string {
  const v = values.slice(-width), max = Math.max(1, ...v);
  return v.map((x) => fg(level >= 2 ? at(palette.brand, x / max) : color, BARS[Math.min(7, Math.round((x / max) * 7))])).join("");
}

/** A moving highlight sweeping across `text` (the "thinking" shimmer). Plain bold when colours are limited. */
export function shimmer(text: string, frame: number, base: RGB = palette.brand[0], hi: RGB = [255, 255, 255]): string {
  if (level < 2) return bold(text);
  const chars = [...text], pos = (frame * 0.9) % (chars.length + 8) - 4;
  return chars.map((ch, i) => fg(lerp(base, hi, Math.max(0, 1 - Math.abs(i - pos) / 3)), ch)).join("");
}

/** Stacked horizontal bar from weighted segments (for the context map). */
export function stackedBar(parts: { label: string; value: number; color: RGB }[], width = 40): { bar: string; legend: string[] } {
  const total = Math.max(1, parts.reduce((n, p) => n + p.value, 0));
  const cells = parts.map((p) => Math.round((p.value / total) * width));
  let diff = width - cells.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0 && i < cells.length * 2; i++) { const k = i % cells.length; if (diff > 0) { cells[k]++; diff--; } else if (cells[k] > 0) { cells[k]--; diff++; } }
  return {
    bar: parts.map((p, i) => fg(p.color, "█".repeat(cells[i]))).join(""),
    legend: parts.filter((p) => p.value > 0).map((p) => `${fg(p.color, "■")} ${p.label} ${Math.round((p.value / total) * 100)}%`),
  };
}

// ---------------------------------------------------------------- logo
/** Pixel mascot + half-block wordmark, painted along the brand gradient. */
export function logo(version: string): string[] {
  const eyes = fg(palette.brand[2], "◖ ◗");
  const wm1 = "▄▀█ █▀▄▀█ █▄ █ █▀▀ █▀ █▀", wm2 = "█▀█ █ ▀ █ █ ▀█ ██▄ ▄█ ▄█";
  const g = (s: string, p = 0) => gradient(s, palette.brand, p);
  return [
    `${g(" ▗▄▄▄▄▄▖", 0)}   ${g(wm1, 0)}`,
    `${g(" █", 0.05)} ${eyes} ${g("█", 0.2)}   ${g(wm2, 0)}`,
    `${g(" ▝▀▀▀▀▀▘", 0.1)}   ${fg(palette.muted, `v${version} · reliable agents for any model`)}`,
  ];
}

export const TIPS = [
  "Shift+Tab cycles permissions: ask → accept edits → plan",
  "Ctrl+P opens the command palette; Alt+M switches model",
  "Type @ to mention a file; its contents are attached for you",
  "Esc Esc rewinds the conversation and restores your files",
  "Keep typing while it works; Enter steers the agent mid-task",
  "/tokens shows what is eating your context window",
  "/plan makes it read-only until you approve a plan",
  "#note saves a memory; !cmd runs a shell command right now",
  "Drop a markdown file in .amness/commands/ to add your own /command",
  "/verify npm test makes \"done\" mean the tests actually pass",
];
