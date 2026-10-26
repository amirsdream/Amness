// Semantic colour themes for the full-screen UI. Every colour is 0xRRGGBB (or -1 = the terminal's own colour, for the "terminal" theme).
import { DEFAULT, mix } from "./ansi.ts";

export type Theme = {
  name: string; label: string; dark: boolean;
  bg: number; surface: number; surface2: number; border: number; borderStrong: number;
  text: number; dim: number; faint: number;
  accent: number; accent2: number; onAccent: number;
  ok: number; warn: number; err: number; info: number;
  addBg: number; addFg: number; addStrong: number; delBg: number; delFg: number; delStrong: number;
  selection: number; inlineCodeBg: number; inlineCode: number; link: number;
  syn: { keyword: number; string: number; number: number; comment: number; func: number; type: number; punct: number; plain: number };
  gradient: number[];
  tool: { read: number; edit: number; shell: number; web: number; memory: number; plan: number; explore: number; generic: number };
};

const T = (t: Omit<Theme, "tool" | "inlineCodeBg" | "inlineCode" | "link" | "selection" | "borderStrong"> & Partial<Pick<Theme, "tool" | "inlineCodeBg" | "inlineCode" | "link" | "selection" | "borderStrong">>): Theme => ({
  borderStrong: mix(t.border, t.text, 0.25), selection: mix(t.surface2, t.accent, 0.45), inlineCodeBg: t.surface2, inlineCode: t.accent2, link: t.info,
  tool: { read: t.info, edit: t.warn, shell: t.accent, web: t.accent2, memory: t.ok, plan: 0xff79c6, explore: 0xff9e64, generic: t.dim }, ...t,
});

export const THEMES: Record<string, Theme> = {
  aurora: T({
    name: "aurora", label: "Aurora (default)", dark: true,
    bg: 0x0d1017, surface: 0x131824, surface2: 0x1a2133, border: 0x28324a,
    text: 0xdbe2ef, dim: 0x93a0b8, faint: 0x5f6c86, accent: 0x8b7bff, accent2: 0x35d0e6, onAccent: 0x0d1017,
    ok: 0x45d9a0, warn: 0xf6b04c, err: 0xff6b7a, info: 0x62aaff,
    addBg: 0x0f2c21, addFg: 0x7ceab5, addStrong: 0x185a3f, delBg: 0x34161f, delFg: 0xff9aa6, delStrong: 0x6b2433,
    syn: { keyword: 0xc4a7ff, string: 0xa6e07a, number: 0xffa56b, comment: 0x62708c, func: 0x7db4ff, type: 0xffd479, punct: 0x8fe1f2, plain: 0xdbe2ef },
    gradient: [0x8b7bff, 0x35b6ff, 0x35e6b0],
  }),
  "tokyo-night": T({
    name: "tokyo-night", label: "Tokyo Night", dark: true,
    bg: 0x16161e, surface: 0x1a1b26, surface2: 0x24283b, border: 0x3b4261,
    text: 0xc0caf5, dim: 0x9aa5ce, faint: 0x6b749b, accent: 0x7aa2f7, accent2: 0xbb9af7, onAccent: 0x16161e,
    ok: 0x9ece6a, warn: 0xe0af68, err: 0xf7768e, info: 0x7dcfff,
    addBg: 0x1c2f26, addFg: 0x9ece6a, addStrong: 0x2b5a3a, delBg: 0x37202b, delFg: 0xf7768e, delStrong: 0x6a2c3d,
    syn: { keyword: 0xbb9af7, string: 0x9ece6a, number: 0xff9e64, comment: 0x6b749b, func: 0x7aa2f7, type: 0x2ac3de, punct: 0x89ddff, plain: 0xc0caf5 },
    gradient: [0x7aa2f7, 0xbb9af7, 0x7dcfff],
  }),
  catppuccin: T({
    name: "catppuccin", label: "Catppuccin Mocha", dark: true,
    bg: 0x11111b, surface: 0x181825, surface2: 0x313244, border: 0x45475a,
    text: 0xcdd6f4, dim: 0xa6adc8, faint: 0x6c7086, accent: 0xcba6f7, accent2: 0x89dceb, onAccent: 0x11111b,
    ok: 0xa6e3a1, warn: 0xf9e2af, err: 0xf38ba8, info: 0x89b4fa,
    addBg: 0x1d2e25, addFg: 0xa6e3a1, addStrong: 0x2f5a3e, delBg: 0x36212b, delFg: 0xf38ba8, delStrong: 0x6a3040,
    syn: { keyword: 0xcba6f7, string: 0xa6e3a1, number: 0xfab387, comment: 0x6c7086, func: 0x89b4fa, type: 0xf9e2af, punct: 0x94e2d5, plain: 0xcdd6f4 },
    gradient: [0xcba6f7, 0x89b4fa, 0x94e2d5],
  }),
  gruvbox: T({
    name: "gruvbox", label: "Gruvbox Dark", dark: true,
    bg: 0x1d2021, surface: 0x282828, surface2: 0x3c3836, border: 0x504945,
    text: 0xebdbb2, dim: 0xbdae93, faint: 0x7c6f64, accent: 0xfabd2f, accent2: 0x8ec07c, onAccent: 0x1d2021,
    ok: 0xb8bb26, warn: 0xfe8019, err: 0xfb4934, info: 0x83a598,
    addBg: 0x2b3017, addFg: 0xb8bb26, addStrong: 0x4a5a1c, delBg: 0x3c1e1b, delFg: 0xfb7a68, delStrong: 0x6e2b25,
    syn: { keyword: 0xfb5c4a, string: 0xb8bb26, number: 0xd3869b, comment: 0x928374, func: 0xfabd2f, type: 0x83a598, punct: 0x8ec07c, plain: 0xebdbb2 },
    gradient: [0xfabd2f, 0xfe8019, 0xfb4934],
  }),
  nord: T({
    name: "nord", label: "Nord", dark: true,
    bg: 0x242933, surface: 0x2e3440, surface2: 0x3b4252, border: 0x4c566a,
    text: 0xe5e9f0, dim: 0xa7b1c2, faint: 0x7d889c, accent: 0x88c0d0, accent2: 0xb48ead, onAccent: 0x242933,
    ok: 0xa3be8c, warn: 0xebcb8b, err: 0xd9707a, info: 0x81a1c1,
    addBg: 0x27382f, addFg: 0xa3be8c, addStrong: 0x3c5a45, delBg: 0x3d2c33, delFg: 0xe08a93, delStrong: 0x6b3d47,
    syn: { keyword: 0x81a1c1, string: 0xa3be8c, number: 0xc29bbb, comment: 0x7d889c, func: 0x88c0d0, type: 0xebcb8b, punct: 0x8fbcbb, plain: 0xe5e9f0 },
    gradient: [0x88c0d0, 0x81a1c1, 0xb48ead],
  }),
  daylight: T({
    name: "daylight", label: "Daylight (light)", dark: false,
    bg: 0xfbfbfd, surface: 0xf1f3f9, surface2: 0xe6eaf4, border: 0xcdd3e2,
    text: 0x1f2430, dim: 0x4f5970, faint: 0x78819a, accent: 0x5b4bdb, accent2: 0x0b7d92, onAccent: 0xffffff,
    ok: 0x1a7f4b, warn: 0x9a5700, err: 0xc4283c, info: 0x1d62c9,
    addBg: 0xdcf3e5, addFg: 0x14663a, addStrong: 0xb3e3c6, delBg: 0xfde1e5, delFg: 0xa8202f, delStrong: 0xf6b5bd,
    syn: { keyword: 0x7a3ec7, string: 0x2a7a2a, number: 0xb4530a, comment: 0x6f7993, func: 0x1d5fc4, type: 0x8a6100, punct: 0x096f82, plain: 0x1f2430 },
    gradient: [0x5b4bdb, 0x1d62c9, 0x0b7d92],
  }),
  /** Uses the terminal's own background and palette: no painted surfaces, structure comes from borders only. */
  terminal: T({
    name: "terminal", label: "Terminal (transparent)", dark: true,
    bg: DEFAULT, surface: DEFAULT, surface2: DEFAULT, border: 0x1000000 + 8,
    text: DEFAULT, dim: 0x1000000 + 7, faint: 0x1000000 + 8, accent: 0x1000000 + 13, accent2: 0x1000000 + 14, onAccent: 0x1000000 + 0,
    ok: 0x1000000 + 10, warn: 0x1000000 + 11, err: 0x1000000 + 9, info: 0x1000000 + 12,
    addBg: DEFAULT, addFg: 0x1000000 + 10, addStrong: DEFAULT, delBg: DEFAULT, delFg: 0x1000000 + 9, delStrong: DEFAULT,
    syn: { keyword: 0x1000000 + 13, string: 0x1000000 + 10, number: 0x1000000 + 11, comment: 0x1000000 + 8, func: 0x1000000 + 12, type: 0x1000000 + 14, punct: 0x1000000 + 6, plain: DEFAULT },
    gradient: [0x1000000 + 13, 0x1000000 + 12, 0x1000000 + 14],
    tool: { read: 0x1000000 + 12, edit: 0x1000000 + 11, shell: 0x1000000 + 13, web: 0x1000000 + 14, memory: 0x1000000 + 10, plan: 0x1000000 + 13, explore: 0x1000000 + 9, generic: 0x1000000 + 7 },
    selection: 0x1000000 + 4,
  }),
};

export const themeNames = () => Object.keys(THEMES);
export const getTheme = (name?: string) => THEMES[name ?? ""] ?? THEMES.aurora;

/** WCAG relative luminance / contrast ratio, used by tests to keep every theme readable. */
const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: number) => 0.2126 * lin((c >> 16) & 255) + 0.7152 * lin((c >> 8) & 255) + 0.0722 * lin(c & 255);
export const contrast = (a: number, b: number) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
