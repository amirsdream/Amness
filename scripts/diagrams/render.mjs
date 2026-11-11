// Draws the diagrams in docs/diagrams/ from the specs in specs.mjs, with no dependencies:
//   node scripts/diagrams/render.mjs            all diagrams
//   node scripts/diagrams/render.mjs 02-one-turn one diagram
// Each diagram is written twice: <name>.excalidraw (open and edit it in excalidraw.com or the VS Code Excalidraw extension)
// and <name>.svg (a hand-drawn picture that GitHub shows in Markdown). The SVG embeds Excalifont (SIL Open Font License),
// the font Excalidraw draws with, so it looks the same everywhere.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIAGRAMS } from "./specs.mjs";

const here = dirname(fileURLToPath(import.meta.url)), out = join(here, "..", "..", "docs", "diagrams");
const FONT = readFileSync(join(here, "Excalifont-latin.woff2")).toString("base64");

// Excalidraw's own colours: a stroke and a light fill for each.
export const COLORS = {
  ink: ["#1e1e1e", "transparent"], gray: ["#495057", "#e9ecef"], blue: ["#1971c2", "#a5d8ff"], green: ["#2f9e44", "#b2f2bb"], yellow: ["#e67700", "#ffec99"],
  red: ["#e03131", "#ffc9c9"], violet: ["#6741d9", "#d0bfff"], orange: ["#e8590c", "#ffd8a8"], teal: ["#0c8599", "#96f2d7"], pink: ["#c2255c", "#fcc2d7"],
};
const LINE = 1.25;   // Excalidraw's line height for its hand-drawn font

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n) => Math.round(n * 100) / 100;

/** One diagram: the shapes, texts and arrows of a spec, resolved to positions. */
function layout(spec) {
  const nodes = new Map();
  for (const n of spec.nodes ?? []) nodes.set(n.id, { shape: "rect", color: "gray", size: 18, align: "center", ...n });
  // a frame with an id can be the end of an arrow too
  const targets = new Map(nodes); for (const fr of spec.frames ?? []) if (fr.id) targets.set(fr.id, { shape: "rect", ...fr });
  const edge = (n, toward) => {
    // the point where the line from n's centre toward `toward` leaves n's outline
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = toward[0] - cx, dy = toward[1] - cy;
    if (!dx && !dy) return [cx, cy];
    if (n.shape === "ellipse") { const t = 1 / Math.sqrt((dx * dx) / ((n.w / 2) ** 2) + (dy * dy) / ((n.h / 2) ** 2)); return [cx + dx * t, cy + dy * t]; }
    if (n.shape === "diamond") { const t = 1 / (Math.abs(dx) / (n.w / 2) + Math.abs(dy) / (n.h / 2)); return [cx + dx * t, cy + dy * t]; }
    const t = Math.min(dx ? (n.w / 2) / Math.abs(dx) : Infinity, dy ? (n.h / 2) / Math.abs(dy) : Infinity); return [cx + dx * t, cy + dy * t];
  };
  const side = (n, s) => ({ top: [n.x + n.w / 2, n.y], bottom: [n.x + n.w / 2, n.y + n.h], left: [n.x, n.y + n.h / 2], right: [n.x + n.w, n.y + n.h / 2] })[s];
  const arrows = (spec.arrows ?? []).map((a, i) => {
    const A = targets.get(a.from), B = targets.get(a.to);
    if (!A || !B) throw new Error(`${spec.name}: arrow ${i} names a missing node (${a.from} -> ${a.to})`);
    const via = a.via ?? [], gap = 6;
    const ca = [A.x + A.w / 2, A.y + A.h / 2], cb = [B.x + B.w / 2, B.y + B.h / 2];
    let p0 = a.fromAt ?? (a.fromSide ? side(A, a.fromSide) : edge(A, via[0] ?? a.toAt ?? cb)), p1 = a.toAt ?? (a.toSide ? side(B, a.toSide) : edge(B, via.at(-1) ?? a.fromAt ?? ca));
    const nudge = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1; return [p[0] + (dx / l) * gap, p[1] + (dy / l) * gap]; };
    p0 = nudge(p0, via[0] ?? p1); p1 = nudge(p1, via.at(-1) ?? p0);
    return { ...a, points: [p0, ...via, p1], color: a.color ?? "ink" };
  });
  return { ...spec, nodes: [...nodes.values()], arrows, texts: spec.texts ?? [], frames: spec.frames ?? [] };
}

// ---- the hand-drawn SVG ---------------------------------------------------------------------------------------------
function roughLine(r, [x1, y1], [x2, y2], rough = 1) {
  const len = Math.hypot(x2 - x1, y2 - y1), off = Math.min(2.2, len * 0.012) * rough, j = () => (r() * 2 - 1) * off;
  const pass = (k) => { const bow = (r() * 2 - 1) * Math.min(3, len * 0.008) * rough * k, mx = (x1 + x2) / 2 + j() + (-(y2 - y1) / (len || 1)) * bow, my = (y1 + y2) / 2 + j() + ((x2 - x1) / (len || 1)) * bow;
    return `M${f(x1 + j())} ${f(y1 + j())} Q${f(mx)} ${f(my)} ${f(x2 + j())} ${f(y2 + j())}`; };
  return pass(1) + " " + pass(-0.6);
}
function shapePath(r, n) {
  if (n.shape === "ellipse") {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2, pass = (k) => { const pts = [], start = r() * Math.PI * 2, steps = 18;
      for (let i = 0; i <= steps + 1; i++) { const a = start + (i / steps) * Math.PI * 2 * (1 + 0.04 * k), d = 1 + (r() * 2 - 1) * 0.012; pts.push([cx + Math.cos(a) * (n.w / 2) * d, cy + Math.sin(a) * (n.h / 2) * d]); }
      return "M" + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(" L"); };
    return { fill: `M${f(cx - n.w / 2)} ${f(cy)} a${f(n.w / 2)} ${f(n.h / 2)} 0 1 0 ${f(n.w)} 0 a${f(n.w / 2)} ${f(n.h / 2)} 0 1 0 ${f(-n.w)} 0Z`, stroke: pass(1) + " " + pass(-1) };
  }
  const c = n.shape === "diamond" ? [[n.x + n.w / 2, n.y], [n.x + n.w, n.y + n.h / 2], [n.x + n.w / 2, n.y + n.h], [n.x, n.y + n.h / 2]]
    : [[n.x, n.y], [n.x + n.w, n.y], [n.x + n.w, n.y + n.h], [n.x, n.y + n.h]];
  if (n.shape === "rect") {
    // rounded corners like Excalidraw's default ("round" edges), drawn as four rough sides and four small arcs
    const rad = Math.min(16, n.w * 0.12, n.h * 0.25), [x, y, w, h] = [n.x, n.y, n.w, n.h];
    const fill = `M${f(x + rad)} ${f(y)} H${f(x + w - rad)} Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + rad)} V${f(y + h - rad)} Q${f(x + w)} ${f(y + h)} ${f(x + w - rad)} ${f(y + h)} H${f(x + rad)} Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - rad)} V${f(y + rad)} Q${f(x)} ${f(y)} ${f(x + rad)} ${f(y)}Z`;
    const sides = [roughLine(r, [x + rad, y], [x + w - rad, y]), roughLine(r, [x + w, y + rad], [x + w, y + h - rad]), roughLine(r, [x + w - rad, y + h], [x + rad, y + h]), roughLine(r, [x, y + h - rad], [x, y + rad])];
    const corners = `M${f(x + w - rad)} ${f(y)} Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + rad)} M${f(x + w)} ${f(y + h - rad)} Q${f(x + w)} ${f(y + h)} ${f(x + w - rad)} ${f(y + h)} M${f(x + rad)} ${f(y + h)} Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - rad)} M${f(x)} ${f(y + rad)} Q${f(x)} ${f(y)} ${f(x + rad)} ${f(y)}`;
    return { fill, stroke: sides.join(" ") + " " + corners };
  }
  return { fill: "M" + c.map((p) => `${f(p[0])} ${f(p[1])}`).join(" L") + "Z", stroke: c.map((p, i) => roughLine(r, p, c[(i + 1) % 4])).join(" ") };
}
function textSvg(x, y, lines, size, color, align = "center", weight = "normal") {
  const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  return lines.map((l, i) => `<text x="${f(x)}" y="${f(y + i * size * LINE)}" font-size="${size}" fill="${color}" text-anchor="${anchor}" dominant-baseline="middle"${weight !== "normal" ? ` font-weight="${weight}"` : ""}>${esc(l)}</text>`).join("");
}
function svg(d) {
  const r = rng(d.seed ?? 7), parts = [];
  for (const fr of d.frames) {
    const [sc, bg] = COLORS[fr.color ?? "gray"];
    parts.push(`<path d="${shapePath(r, { ...fr, shape: "rect" }).fill}" fill="${bg}" fill-opacity="0.28" stroke="none"/>`);
    parts.push(`<path d="${shapePath(r, { ...fr, shape: "rect" }).stroke}" fill="none" stroke="${sc}" stroke-width="1.6" stroke-dasharray="9 7" stroke-linecap="round"/>`);
    if (fr.label) parts.push(textSvg(fr.x + 16, fr.y + 20, [fr.label], fr.size ?? 20, sc, "left"));
  }
  for (const a of d.arrows) {
    const [sc] = COLORS[a.color], pts = a.points, segs = pts.slice(1).map((p, i) => roughLine(r, pts[i], p, 0.8)).join(" ");
    parts.push(`<path d="${segs}" fill="none" stroke="${sc}" stroke-width="1.8" stroke-linecap="round"${a.dashed ? ` stroke-dasharray="8 7"` : ""}/>`);
    const [p, q] = [pts.at(-2), pts.at(-1)], ang = Math.atan2(q[1] - p[1], q[0] - p[0]), L = 14;
    const head = (s) => [q[0] - L * Math.cos(ang + s), q[1] - L * Math.sin(ang + s)];
    parts.push(`<path d="${roughLine(r, head(0.45), q, 0.5)} ${roughLine(r, head(-0.45), q, 0.5)}" fill="none" stroke="${sc}" stroke-width="1.8" stroke-linecap="round"/>`);
    if (a.both) { const [p2, q2] = [pts[1], pts[0]], an2 = Math.atan2(q2[1] - p2[1], q2[0] - p2[0]), h2 = (s) => [q2[0] - L * Math.cos(an2 + s), q2[1] - L * Math.sin(an2 + s)];
      parts.push(`<path d="${roughLine(r, h2(0.45), q2, 0.5)} ${roughLine(r, h2(-0.45), q2, 0.5)}" fill="none" stroke="${sc}" stroke-width="1.8" stroke-linecap="round"/>`); }
    if (a.label) { const m = labelAt(a), lines = String(a.label).split("\n"), size = a.size ?? 15, w = Math.max(...lines.map((l) => l.length)) * size * 0.52 + 10, h = lines.length * size * LINE + 4;
      parts.push(`<rect x="${f(m[0] - w / 2)}" y="${f(m[1] - h / 2)}" width="${f(w)}" height="${f(h)}" fill="#ffffff" fill-opacity="0.92"/>`);
      parts.push(textSvg(m[0], m[1] - ((lines.length - 1) * size * LINE) / 2, lines, size, sc)); }
  }
  for (const n of d.nodes) {
    const [sc, bg] = COLORS[n.color], p = shapePath(r, n);
    parts.push(`<path d="${p.fill}" fill="${bg}" stroke="none"/>`, `<path d="${p.stroke}" fill="none" stroke="${n.color === "ink" ? sc : sc}" stroke-width="${n.bold ? 2.6 : 1.8}" stroke-linecap="round"${n.dashed ? ` stroke-dasharray="8 7"` : ""}/>`);
    const lines = String(n.text).split("\n"), h = lines.length * n.size * LINE;
    const tx = n.align === "left" ? n.x + 14 : n.x + n.w / 2;
    parts.push(textSvg(tx, n.y + n.h / 2 - h / 2 + (n.size * LINE) / 2, lines, n.size, "#1e1e1e", n.align));
  }
  for (const t of d.texts) parts.push(textSvg(t.x, t.y, String(t.text).split("\n"), t.size ?? 18, COLORS[t.color ?? "ink"][0], t.align ?? "left"));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}">
<!-- Made by scripts/diagrams/render.mjs from scripts/diagrams/specs.mjs; the editable drawing is ${d.name}.excalidraw. -->
<defs><style>@font-face{font-family:"Excalifont";src:url(data:font/woff2;base64,${FONT}) format("woff2");}text{font-family:"Excalifont","Virgil","Segoe Print","Comic Sans MS",cursive;}</style></defs>
<rect width="100%" height="100%" fill="#ffffff"/>
${parts.join("\n")}
</svg>
`;
}
function labelAt(a) {
  const pts = a.points, i = a.labelSeg ?? Math.floor((pts.length - 1) / 2), [p, q] = [pts[i], pts[i + 1]], t = a.labelPos ?? 0.5;
  return [p[0] + (q[0] - p[0]) * t + (a.labelDx ?? 0), p[1] + (q[1] - p[1]) * t + (a.labelDy ?? 0)];
}

// ---- the editable Excalidraw scene ----------------------------------------------------------------------------------
function excalidraw(d) {
  const r = rng(d.seed ?? 7), seed = () => Math.floor(r() * 2 ** 31), els = [], idOf = new Map();
  const base = (o) => ({ angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null,
    roundness: null, seed: seed(), version: 1, versionNonce: seed(), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...o });
  const text = (id, x, y, s, size, color, align, containerId = null, w = null) => {
    const lines = String(s).split("\n"), width = w ?? Math.max(...lines.map((l) => l.length)) * size * 0.55, height = lines.length * size * LINE;
    return base({ id, type: "text", x, y, width, height, strokeColor: color, text: s, originalText: s, fontSize: size, fontFamily: 5, textAlign: align, verticalAlign: containerId ? "middle" : "top", containerId, autoResize: true, lineHeight: LINE, baseline: Math.round(size * 0.9) });
  };
  d.frames.forEach((fr, i) => {
    const [sc, bg] = COLORS[fr.color ?? "gray"];
    if (fr.id) idOf.set(fr.id, `frame-${i}`);
    els.push(base({ id: `frame-${i}`, type: "rectangle", x: fr.x, y: fr.y, width: fr.w, height: fr.h, strokeColor: sc, backgroundColor: bg, opacity: 35, strokeStyle: "dashed", roundness: { type: 3 } }));
    if (fr.label) els.push(text(`frame-${i}-label`, fr.x + 16, fr.y + 8, fr.label, fr.size ?? 20, sc, "left"));
  });
  for (const n of d.nodes) {
    const [sc, bg] = COLORS[n.color], id = `n-${n.id}`, tid = `t-${n.id}`; idOf.set(n.id, id);
    els.push(base({ id, type: n.shape === "rect" ? "rectangle" : n.shape, x: n.x, y: n.y, width: n.w, height: n.h, strokeColor: sc, backgroundColor: bg, strokeWidth: n.bold ? 4 : 2, strokeStyle: n.dashed ? "dashed" : "solid", roundness: n.shape === "rect" ? { type: 3 } : n.shape === "diamond" ? { type: 2 } : null, boundElements: [{ type: "text", id: tid }] }));
    const lines = String(n.text).split("\n"), h = lines.length * n.size * LINE;
    els.push(text(tid, n.x + 8, n.y + n.h / 2 - h / 2, n.text, n.size, "#1e1e1e", n.align === "left" ? "left" : "center", id, n.w - 16));
  }
  d.arrows.forEach((a, i) => {
    const [sc] = COLORS[a.color], [x0, y0] = a.points[0], id = `a-${i}`;
    const el = base({ id, type: "arrow", x: x0, y: y0, width: 0, height: 0, strokeColor: sc, strokeStyle: a.dashed ? "dashed" : "solid", roundness: a.points.length > 2 ? null : { type: 2 },
      points: a.points.map(([x, y]) => [x - x0, y - y0]), lastCommittedPoint: null, startArrowhead: a.both ? "arrow" : null, endArrowhead: "arrow", elbowed: false,
      startBinding: { elementId: idOf.get(a.from), focus: 0, gap: 6 }, endBinding: { elementId: idOf.get(a.to), focus: 0, gap: 6 } });
    const xs = el.points.map((p) => p[0]), ys = el.points.map((p) => p[1]); el.width = Math.max(...xs) - Math.min(...xs); el.height = Math.max(...ys) - Math.min(...ys);
    for (const end of [a.from, a.to]) { const box = els.find((e) => e.id === idOf.get(end)); box.boundElements = [...(box.boundElements ?? []), { type: "arrow", id }]; }
    els.push(el);
    if (a.label) { const m = labelAt(a), size = a.size ?? 15, lines = String(a.label).split("\n"), w = Math.max(...lines.map((l) => l.length)) * size * 0.55;
      const t = text(`${id}-label`, m[0] - w / 2, m[1] - (lines.length * size * LINE) / 2, a.label, size, sc, "center", id, w); els.push(t); el.boundElements = [{ type: "text", id: t.id }]; }
  });
  d.texts.forEach((t, i) => {
    const size = t.size ?? 18, lines = String(t.text).split("\n"), w = Math.max(...lines.map((l) => l.length)) * size * 0.55, align = t.align ?? "left";
    els.push(text(`text-${i}`, align === "center" ? t.x - w / 2 : align === "right" ? t.x - w : t.x, t.y - (size * LINE) / 2, t.text, size, COLORS[t.color ?? "ink"][0], align));
  });
  return JSON.stringify({ type: "excalidraw", version: 2, source: "https://github.com/amirsdream/Amness/tree/main/scripts/diagrams", elements: els, appState: { viewBackgroundColor: "#ffffff", gridSize: 20 }, files: {} }, null, 1) + "\n";
}

const only = process.argv.slice(2);
mkdirSync(out, { recursive: true });
for (const spec of DIAGRAMS) {
  if (only.length && !only.includes(spec.name)) continue;
  const d = layout(spec);
  writeFileSync(join(out, `${spec.name}.svg`), svg(d));
  writeFileSync(join(out, `${spec.name}.excalidraw`), excalidraw(d));
  console.log(`docs/diagrams/${spec.name}.svg  .excalidraw`);
}
