// Amness desktop: the window. It shows the terminal app's own App (cli/desktop/bridge.ts) through the local server: events arrive on /events, actions go to /api/*.
// Every command, dialog, approval and panel comes from the App, so the terminal and the desktop always have the same features.
// Everything the model, a tool or a file says is put on the page as text (textContent), never as HTML.
"use strict";

// ------------------------------------------------------------------ access token and API
const TOKEN = new URLSearchParams(location.hash.slice(1)).get("t") || sessionStorage.getItem("amness-token") || "";
try { sessionStorage.setItem("amness-token", TOKEN); } catch { /* storage off */ }
history.replaceState(null, "", "/");                                               // keep the token out of the address bar and history

async function api(path, body) {
  const r = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "x-amness-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
  return j;
}
const tryApi = async (path, body) => { try { return await api(path, body); } catch (e) { toast("error", e.message); return undefined; } };
/** Run anything the terminal accepts: a /command, !shell, #note or a message. */
const run = (text) => tryApi("/api/send", { text });

// ------------------------------------------------------------------ small DOM helpers
const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v;                                   // through CSSOM: the CSP forbids style attributes
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n));
const fmtCost = (c) => (c === null || c === undefined ? "n/a" : c < 0.01 ? "<$0.01" : "$" + c.toFixed(2));
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
function copy(text, what = "copied") { navigator.clipboard.writeText(text).then(() => toast("ok", what), () => toast("warn", "could not copy")); }
function toast(level, text) {
  const t = h("div", { class: `toast ${level}`, text }); $("toasts").append(t);
  setTimeout(() => t.remove(), level === "error" ? 7000 : 3500);
}
const SVGNS = "http://www.w3.org/2000/svg";
/** A small bar chart of numbers (tokens per request), as inline SVG. */
function spark(values, w = 120, hgt = 22) {
  const svg = document.createElementNS(SVGNS, "svg"); svg.setAttribute("width", w); svg.setAttribute("height", hgt); svg.setAttribute("class", "spark");
  const v = values.slice(-Math.floor(w / 4)), mx = Math.max(1, ...v), bw = w / Math.max(1, v.length);
  v.forEach((x, i) => { const r = document.createElementNS(SVGNS, "rect"), hh = Math.max(1, (x / mx) * (hgt - 2)); r.setAttribute("x", (i * bw).toFixed(1)); r.setAttribute("y", (hgt - hh).toFixed(1)); r.setAttribute("width", Math.max(1, bw - 1).toFixed(1)); r.setAttribute("height", hh.toFixed(1)); svg.append(r); });
  return svg;
}
/** A theme colour from the App (0xRRGGBB, or 0x1000000 + a 256-colour index) as CSS. */
function themeColor(c) { if (c === undefined || c < 0) return ""; if (c >= 0x1000000) return pal256(c - 0x1000000); return "#" + c.toString(16).padStart(6, "0"); }

// ------------------------------------------------------------------ ANSI text (what commands print, the run panel) as coloured spans
const BASIC = ["k", "r", "g", "y", "b", "m", "c", "w"];
function pal256(n) {
  if (n < 16) return `var(--ansi-${n < 8 ? BASIC[n] : "b" + BASIC[n - 8]})`;
  if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
  const i = n - 16, v = (x) => (x ? 55 + x * 40 : 0); return `rgb(${v(Math.floor(i / 36))},${v(Math.floor(i / 6) % 6)},${v(i % 6)})`;
}
function ansi(line) {
  const out = h("span", { class: "ansi" }); let st = {};
  const parts = String(line).split(/(\x1b\[[0-9;:]*m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/);
  for (const p of parts) {
    if (!p) continue;
    if (p[0] === "\x1b") {
      if (!p.endsWith("m") || p[1] !== "[") continue;
      const codes = p.slice(2, -1).split(/[;:]/).map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i] || 0;
        if (c === 0) st = {}; else if (c === 1) st.b = 1; else if (c === 2) st.d = 1; else if (c === 3) st.i = 1; else if (c === 4) st.u = 1; else if (c === 7) st.inv = 1; else if (c === 9) st.s = 1;
        else if (c === 22) { st.b = 0; st.d = 0; } else if (c === 23) st.i = 0; else if (c === 24) st.u = 0; else if (c === 27) st.inv = 0; else if (c === 29) st.s = 0;
        else if (c >= 30 && c <= 37) st.fg = pal256(c - 30); else if (c >= 90 && c <= 97) st.fg = pal256(c - 82); else if (c === 39) st.fg = "";
        else if (c >= 40 && c <= 47) st.bg = pal256(c - 40); else if (c >= 100 && c <= 107) st.bg = pal256(c - 92); else if (c === 49) st.bg = "";
        else if ((c === 38 || c === 48) && codes[i + 1] === 5) { (c === 38 ? (st.fg = pal256(codes[i + 2])) : (st.bg = pal256(codes[i + 2]))); i += 2; }
        else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const col = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; c === 38 ? (st.fg = col) : (st.bg = col); i += 4; }
      }
      continue;
    }
    const s = h("span", { text: p }), css = [];
    if (st.fg) css.push(`color:${st.inv ? "var(--bg)" : st.fg}`); if (st.bg || st.inv) css.push(`background:${st.inv ? st.fg || "var(--text)" : st.bg}`);
    if (st.b) css.push("font-weight:650"); if (st.d) css.push("opacity:.62"); if (st.i) css.push("font-style:italic");
    if (st.u || st.s) css.push(`text-decoration:${st.u ? "underline" : ""} ${st.s ? "line-through" : ""}`);
    if (css.length) s.style.cssText = css.join(";");
    out.append(s);
  }
  return out;
}
const ansiLines = (lines, cls = "term") => h("div", { class: cls }, lines.map((l) => h("div", { class: "tl" }, ansi(l))));
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

// ------------------------------------------------------------------ preferences: kept by the server in the Amness config (this page's address changes every launch, so its own storage would forget)
let prefs = {};
const pref = (k, d) => (prefs[k] === undefined ? d : prefs[k]);
let prefsT, prefsDirty = {};
function setPref(k, v) { prefs[k] = v; prefsDirty[k] = v; clearTimeout(prefsT); prefsT = setTimeout(() => { const p = prefsDirty; prefsDirty = {}; api("/api/prefs", p).catch(() => {}); }, 250); }
const ACCENTS = { violet: ["#8b7cf6", "#6d5ce8"], blue: ["#5b9cff", "#2f6fe0"], teal: ["#2ec5b6", "#0f8f83"], green: ["#4ccf8a", "#18a058"], amber: ["#f5a54b", "#c97212"], pink: ["#f472b6", "#cf3f8a"] };
const lightNow = () => { const t = pref("theme", "system"); return t === "light" || (t === "system" && matchMedia("(prefers-color-scheme: light)").matches); };
/** Apply the appearance preferences to the page (and tell the server which scheme, so command output is coloured to match). */
function applyPrefs() {
  const root = document.documentElement, t = pref("theme", "system");
  if (t === "system") delete root.dataset.theme; else root.dataset.theme = t;
  const a = ACCENTS[pref("accent", "violet")] ?? ACCENTS.violet, col = lightNow() ? a[1] : a[0];
  root.style.setProperty("--accent", col); root.style.setProperty("--sel", col + (lightNow() ? "1f" : "33"));
  root.style.zoom = String(pref("uiScale", 1));
  root.style.setProperty("--chat-size", `${pref("chatSize", 14)}px`);
  const font = String(pref("codeFont", "")).trim().replace(/[;{}"]/g, "");
  if (font) root.style.setProperty("--mono", `"${font}", var(--mono-base)`); else root.style.removeProperty("--mono");
  document.body.classList.toggle("compact", pref("density", "comfortable") === "compact");
  document.body.classList.toggle("reduce-motion", !!pref("reduceMotion", false));
  if (TOKEN) api("/api/scheme", { scheme: lightNow() ? "light" : "dark" }).catch(() => {});
}

// ------------------------------------------------------------------ state
let state = null, sd = null;                       // StateView from the server; sd = its sidebar data
const blocks = new Map();                          // id -> block
let order = [];                                    // block ids in transcript order
let expandAll = false;                             // Ctrl/⌘ E: every card open
let files = [], fileSet = new Set();               // the project's files: @ mentions, links, the tree
const changedLines = new Map();                    // path -> new-side line numbers changed in this session
let viewerPath = null, commands = [];

// ------------------------------------------------------------------ markdown (safe: builds DOM nodes, never parses HTML)
function inline(text) {
  const out = [], re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|((?<![\w*])\*[^*\n]+\*(?!\w))|((?<![\w./@-])(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]{1,10}(?::\d+)?)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) { const code = m[1].slice(1, -1); out.push(fileLinkOr(code, () => h("code", { text: code }), true)); }
    else if (m[2]) out.push(h("strong", {}, inline(m[2].slice(2, -2))));
    else if (m[3]) { const url = m[4], lab = m[3].slice(1, m[3].indexOf("](")); out.push(h("a", { href: url, title: url, onclick: (e) => { e.preventDefault(); window.open(url, "_blank"); } }, lab)); }
    else if (m[5]) { const url = m[5]; out.push(h("a", { href: url, onclick: (e) => { e.preventDefault(); window.open(url, "_blank"); } }, url)); }
    else if (m[6]) out.push(h("em", {}, inline(m[6].slice(1, -1))));
    else if (m[7]) { const t = m[7]; out.push(fileLinkOr(t, () => t)); }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/** A file path the project really has becomes a link that opens it in the file view. */
function fileLinkOr(raw, otherwise, code = false) {
  const m = /^(.*?)(?::(\d+))?$/.exec(raw), path = m[1].replace(/^\.\//, "");
  if (!fileSet.has(path)) return otherwise();
  return h(code ? "code" : "span", { class: "filelink", title: `Open ${path}`, onclick: () => openFile(path, m[2] ? Number(m[2]) : undefined) }, raw);
}
function md(src) {
  const root = h("div", { class: "md" }), L = String(src).replace(/\r/g, "").split("\n"), para = [];
  let i = 0;
  const flush = () => { if (para.length) { root.append(h("p", {}, inline(para.join(" ")))); para.length = 0; } };
  while (i < L.length) {
    const line = L[i], fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush(); const body = []; i++;
      while (i < L.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(L[i])) body.push(L[i++]);
      i++; root.append(codeBlock(body.join("\n"), fence[2])); continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) { flush(); root.append(h(`h${Math.min(4, hd[1].length)}`, {}, inline(hd[2]))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); root.append(h("hr")); i++; continue; }
    if (/^\s*>/.test(line)) { flush(); const q = []; while (i < L.length && /^\s*>/.test(L[i])) q.push(L[i++].replace(/^\s*>\s?/, "")); root.append(h("blockquote", {}, md(q.join("\n")))); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
      flush(); const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line); i += 2; const rows = [];
      while (i < L.length && /^\s*\|.*\|\s*$/.test(L[i])) rows.push(cells(L[i++]));
      root.append(h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((c) => h("th", {}, inline(c))))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, inline(c)))))))));
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush(); const ordered = /\d/.test(li[2]), list = h(ordered ? "ol" : "ul");
      while (i < L.length) {
        const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(L[i]);
        if (!mm) { if (/^\s{2,}\S/.test(L[i]) && list.lastChild) { list.lastChild.append(" ", ...inline(L[i].trim())); i++; continue; } break; }
        const item = h("li", {}, inline(mm[3].replace(/^\[( |x)\]\s+/i, (s) => (/x/i.test(s) ? "☑ " : "☐ "))));
        if (mm[1].length >= 2 && list.lastChild) { let sub = list.lastChild.querySelector(":scope > ul, :scope > ol"); if (!sub) { sub = h(ordered ? "ol" : "ul"); list.lastChild.append(sub); } sub.append(item); } else list.append(item);
        i++;
      }
      root.append(list); continue;
    }
    para.push(line.trim()); i++;
  }
  flush();
  return root;
}
function codeBlock(code, lang) {
  return h("div", { class: "codeblock" },
    h("div", { class: "bar" }, h("span", { text: lang || "code" }), h("span", { class: "spacer" }), h("button", { class: "copy", onclick: () => copy(code, "code copied") }, "Copy")),
    h("pre", {}, h("code", { text: code })));
}

// ------------------------------------------------------------------ diffs
function diffView(diff, maxRows = 400) {
  const box = h("div", { class: "diff" }); let a = 0, b = 0, n = 0;
  const row = (cls, x, y, sign, text) => h("div", { class: `row ${cls}` }, h("span", { class: "n", text: String(x) }), h("span", { class: "n", text: String(y) }), h("span", { class: "s", text: sign }), h("span", { class: "c", text }));
  for (const line of String(diff).split("\n")) {
    if (/^(---|\+\+\+|diff |index )/.test(line)) continue;
    const hk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hk) { a = Number(hk[1]); b = Number(hk[2]); box.append(row("hunk", "", "", "", line)); continue; }
    if (!line && n > 0) continue;
    if (++n > maxRows) { box.append(row("hunk", "", "", "", "… more lines (open the file to see all)")); break; }
    const s = line[0], c = line.slice(1);
    if (s === "+") box.append(row("add", "", b++, "+", c)); else if (s === "-") box.append(row("del", a++, "", "−", c)); else box.append(row("", a++, b++, " ", s === " " ? c : line));
  }
  return box;
}
function addedLines(diff) {
  const out = new Set(); let b = 0;
  for (const line of String(diff).split("\n")) {
    const hk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line); if (hk) { b = Number(hk[1]); continue; }
    if (/^(\+\+\+|---)/.test(line)) continue;
    if (line[0] === "+") out.add(b++); else if (line[0] !== "-") b++;
  }
  return out;
}

// ------------------------------------------------------------------ what is open: your own choices win; otherwise the step happening now is open and the rest is folded
const userOpen = new Map();                        // key -> open/closed, set when you click
const showAll = new Set();                         // tool outputs you asked to see in full
/** Is the card with this key open? `auto` = it is the latest step of the running turn, so it shows itself. */
const opened = (key, auto) => (userOpen.has(key) ? userOpen.get(key) : expandAll || auto);
const flip = (key, auto) => { userOpen.set(key, !opened(key, auto)); render(true); };

// ------------------------------------------------------------------ tool cards
const LABEL = { read_file: "Read", write_file: "Write", edit_file: "Edit", apply_patch: "Patch", sh: "Run", sh_read: "Run", grep: "Search", list_files: "List", repo_map: "Map", find_refs: "References", impact: "Impact", task: "Agent", web_search: "Web search", fetch_url: "Fetch", todo_write: "Todos", exit_plan_mode: "Plan", skill: "Skill", memory_save: "Remember", memory_search: "Recall", tool_search: "Load tools" };
const QUIET = new Set(["read_file", "grep", "list_files", "repo_map", "find_refs", "impact", "glob", "skill", "tool_search", "memory_search"]);
const label = (name) => LABEL[name] || name.replace(/_/g, " ");
function argOf(args) { try { const a = JSON.parse(args || "{}"); return String(a.path ?? a.cmd ?? a.pattern ?? a.query ?? a.url ?? a.description ?? a.name ?? "").replace(/\s+/g, " "); } catch { return ""; } }
function prettyArgs(args) { try { return JSON.stringify(JSON.parse(args || "{}"), null, 2); } catch { return String(args || ""); } }
const statusIcon = (b) => (b.status === "running" ? "◌" : b.status === "ok" ? "✓" : "✗");
const kidsOf = (callId) => order.map((id) => blocks.get(id)).filter((k) => k && k.kind === "tool" && k.parent === callId);
const dur = (ms) => (ms < 1000 ? `${ms}ms` : fmtDur(ms));

function toolCard(b, auto) {
  const open = opened(b.id, auto || b.status === "running" && b.name === "sh");
  const meta = [];
  if (b.edit) meta.push(h("span", { class: "a", text: `+${b.edit.added}` }), " ", h("span", { class: "r", text: `−${b.edit.removed}` }));
  else if (b.name === "sh" && b.result) { const m = /^exit=(\w+)/.exec(b.result); if (m) meta.push(`exit ${m[1]}`); }
  if (b.status === "running") meta.push(h("span", { class: "live-ms", dataset: { t0: String(b.t0) } }));
  else if (b.ms !== undefined) meta.push(meta.length ? " · " : "", dur(b.ms));
  const who = b.agent && b.agent !== "lead" && !b.parent ? ` (${b.agent})` : "";
  const card = h("div", { class: `step tool ${b.status}${open ? " open" : ""}` },
    h("button", { class: "tool-head", "aria-expanded": String(open), onclick: () => flip(b.id, auto) },
      h("span", { class: "st", text: statusIcon(b) }), h("span", { class: "lbl", text: label(b.name) + who }), h("span", { class: "arg", text: argOf(b.args) }), h("span", { class: "meta" }, meta), h("span", { class: "chev" })));
  if (!open) return card;
  const body = h("div", { class: "tool-body" });
  if (b.edit) body.append(diffView(b.edit.diff));
  else {
    const args = prettyArgs(b.args);
    if (args && args !== "{}" && b.name !== "read_file") body.append(h("details", { class: "args" }, h("summary", { text: "Input" }), h("pre", { text: args })));
    if (b.result !== undefined) {
      const full = showAll.has(b.id), text = b.result.replace(/^exit=\w+\n?/, ""), cut = !full && text.length > 8000;
      body.append(h("pre", { class: "out", text: cut ? text.slice(0, 8000) : text || "(no output)" }));
      if (cut) body.append(h("button", { class: "more", onclick: () => { showAll.add(b.id); render(true); } }, `show all (${fmtTokens(text.length)} characters)`));
    } else body.append(h("pre", { class: "out live", text: b.name === "sh" ? `$ ${argOf(b.args)}` : "working…" }));
  }
  card.append(body);
  return card;
}
function groupCard(members, auto) {
  const key = `g${members[0].id}`, running = members.some((m) => m.status === "running"), failed = members.some((m) => m.status === "fail"), open = opened(key, auto && running);
  const counts = {}; for (const m of members) counts[m.name] = (counts[m.name] || 0) + 1;
  const words = Object.entries(counts).map(([n, c]) => (n === "read_file" ? `${c} file${c > 1 ? "s" : ""} read` : n === "grep" ? `${c} search${c > 1 ? "es" : ""}` : n === "list_files" ? `${c} listing${c > 1 ? "s" : ""}` : `${c} ${label(n).toLowerCase()}`));
  const card = h("div", { class: `step tool group ${running ? "running" : failed ? "fail" : "ok"}${open ? " open" : ""}` },
    h("button", { class: "tool-head", "aria-expanded": String(open), onclick: () => flip(key, auto && running) },
      h("span", { class: "st", text: running ? "◌" : "✓" }), h("span", { class: "lbl", text: running ? "Exploring" : "Explored" }), h("span", { class: "arg", text: words.join(" · ") }),
      running ? h("span", { class: "meta" }, argOf(members.at(-1).args)) : null, h("span", { class: "chev" })));
  if (open) card.append(h("div", { class: "tool-body nested" }, members.map((m) => h("div", { class: `mini ${m.status}` }, h("span", { class: "st", text: statusIcon(m) }), h("span", { class: "lbl", text: label(m.name) }), h("span", { class: "arg", text: argOf(m.args) }), h("span", { class: "meta", text: m.ms !== undefined ? dur(m.ms) : "" })))));
  return card;
}
/** Subagents that ran side by side, in one card: a row each. A working agent shows its newest steps; a finished one folds to one line (click for its steps and its answer). */
function agentsCard(list) {
  const running = list.filter((a) => a.status === "running").length, failed = list.some((a) => a.status === "fail");
  const head = running ? `${running} agent${running > 1 ? "s" : ""} working` + (list.length > running ? ` · ${list.length - running} done` : "") : `${list.length} agent${list.length > 1 ? "s" : ""} done`;
  const rows = list.map((a) => {
    const kids = kidsOf(a.callId), last = kids.at(-1), live = a.status === "running", open = opened(a.id, live);
    let task = ""; try { task = String(JSON.parse(a.args || "{}").description ?? ""); } catch { /* partial args while streaming */ }
    const doing = live ? (last ? `${label(last.name)} ${argOf(last.args)}` : "starting") : a.status === "ok" ? "done" : "failed";
    const row = h("div", { class: `agent-row ${a.status}${open ? " open" : ""}` },
      h("button", { class: "agent-line", "aria-expanded": String(open), onclick: () => flip(a.id, live) },
        h("span", { class: "st", text: statusIcon(a) }), h("span", { class: "task", text: task.replace(/\s+/g, " ") || "subagent" }),
        h("span", { class: "doing", text: doing }), h("span", { class: "meta" }, `${kids.length} step${kids.length === 1 ? "" : "s"} · `, live ? h("span", { class: "live-ms", dataset: { t0: String(a.t0) } }) : dur(a.ms ?? 0)),
        h("span", { class: "chev" })));
    if (open) {
      const shown = live && !userOpen.get(a.id) ? kids.slice(-3) : kids;
      row.append(h("div", { class: "kids" }, shown.length < kids.length ? h("div", { class: "kid faint", text: `… ${kids.length - shown.length} earlier step${kids.length - shown.length > 1 ? "s" : ""}` }) : null,
        shown.map((k) => h("div", { class: "kid" }, h("span", { class: k.status === "running" ? "k-run" : k.status === "ok" ? "k-ok" : "k-fail", text: statusIcon(k) }), h("span", { class: "kl", text: label(k.name) }), h("span", { class: "ka", text: argOf(k.args) })))));
      if (a.result && !live) row.append(h("div", { class: "subresult" }, md(a.result.replace(/^\(no agent named[^\n]*\n/, "").replace(/\s*\[subagent used about[^\]]*\]\s*$/, ""))));
    }
    return row;
  });
  return h("div", { class: `step tool agents ${running ? "running" : failed ? "fail" : "ok"}` }, h("div", { class: "agents-head" }, h("span", { class: "st", text: running ? "◌" : "✓" }), h("span", { class: "lbl", text: head })), ...rows);
}
/** The model's thinking, where it happened: open while it forms, folded to one line once the next step or the answer starts (your own click wins). */
function thinkingItem(t) {
  const key = `th${t.id}`, open = opened(key, t.active);
  const d = h("details", { class: `thinking${t.active ? " live" : ""}` }, h("summary", {}, h("span", { text: t.active ? "Thinking…" : `Thought for ${fmtDur(t.ms ?? 0)}` }), !open && !t.active ? h("span", { class: "think-peek", text: t.text.replace(/\s+/g, " ").trim().slice(0, 120) }) : null),
    h("div", { class: "body", text: t.text.slice(-60000) }));
  if (open) d.open = true;
  d.addEventListener("toggle", () => { if (d.open !== open) { userOpen.set(key, d.open); render(true); } });
  return d;
}
/** The work of a finished turn (its steps and in-between remarks), folded into one line with what it did; the answer stays below it, in full. */
function workCard(units, key) {
  const tools = units.flatMap((u) => (u.group ? u.group : u.agents ? u.agents : u.b && u.b.kind === "tool" ? [u.b] : []));   // thinking lines are inside, but are not steps
  const c = { read: 0, search: 0, edit: 0, run: 0, agent: 0, other: 0 }, files = [];
  for (const t of tools) {
    if (t.edit) { c.edit++; if (!files.includes(t.edit.path)) files.push(t.edit.path); }
    else if (t.name === "read_file") c.read++; else if (["grep", "list_files", "repo_map", "find_refs", "glob"].includes(t.name)) c.search++;
    else if (t.name === "sh" || t.name === "sh_read") c.run++; else if (t.name === "task") c.agent++; else c.other++;
  }
  const t0 = Math.min(...tools.map((t) => t.t0)), t1 = Math.max(...tools.map((t) => t.t0 + (t.ms ?? 0))), failed = tools.filter((t) => t.status === "fail").length, open = opened(key, false);
  const bits = [c.read && `read ${c.read}`, c.search && `searched ${c.search}`, c.edit && `edited ${c.edit}`, c.run && `ran ${c.run}`, c.agent && `${c.agent} agent${c.agent > 1 ? "s" : ""}`, c.other && `${c.other} other`].filter(Boolean);
  const card = h("div", { class: `work${open ? " open" : ""}${failed ? " has-fail" : ""}` },
    h("button", { class: "work-head", "aria-expanded": String(open), onclick: () => flip(key, false) },
      h("span", { class: "chev" }), h("span", { class: "lbl", text: `Worked${tools.length && isFinite(t0) ? " " + fmtDur(Math.max(0, t1 - t0)) : ""}` }),
      h("span", { class: "muted", text: `${tools.length} step${tools.length === 1 ? "" : "s"}${bits.length ? " · " + bits.join(" · ") : ""}` }), failed ? h("span", { class: "fails", text: `${failed} failed` }) : null),
    files.length ? h("div", { class: "work-files" }, files.map((f) => h("button", { class: "file-chip", title: `Open ${f}`, onclick: (e) => { e.stopPropagation(); openFile(f); } }, f.split("/").pop()))) : null);
  if (open) card.append(h("div", { class: "timeline" }, units.map((u) => unitEl(u, false))));
  return card;
}

// ------------------------------------------------------------------ transcript rendering (an element is rebuilt only when what it shows changed)
const cache = new Map();
let renderQueued = false;
function render(now = false) {
  if (now) { renderQueued = false; doRender(); return; }
  if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { if (renderQueued) { renderQueued = false; doRender(); } });
}
const isWork = (u) => u.group || u.agents || u.think || (u.b && (u.b.kind === "tool" || (u.b.kind === "notice" && u.b.level !== "error")));
/** Blocks as display units: runs of quiet reads become one "Explored" step, side-by-side subagents one card. */
function unitsOf(run) {
  const out = [];
  for (let i = 0; i < run.length; i++) {
    const b = run[i];
    if (b.kind === "thinking") { if (b.text.trim() || b.active) out.push({ think: b }); continue; }
    if (b.kind === "tool" && b.name === "task") { let j = i; while (j < run.length && run[j].kind === "tool" && run[j].name === "task") j++; out.push({ agents: run.slice(i, j) }); i = j - 1; continue; }
    if (b.kind === "tool" && QUIET.has(b.name) && !b.edit) { let j = i; while (j < run.length && run[j].kind === "tool" && QUIET.has(run[j].name) && !run[j].edit) j++; if (j - i >= 2) { out.push({ group: run.slice(i, j) }); i = j - 1; continue; } }
    out.push({ b });
  }
  return out;
}
function unitKey(u, auto) {
  const a = auto ? "A" : "", E = expandAll ? "E" : "";
  if (u.group) return `g:${u.group.map((m) => `${m.id}:${m.status}:${m.ms ?? ""}`).join(",")}:${userOpen.get(`g${u.group[0].id}`)}:${a}${E}`;
  if (u.agents) return `ag:${u.agents.map((x) => `${x.id}:${x.status}:${x.result?.length ?? 0}:${userOpen.get(x.id)}:${kidsOf(x.callId).map((k) => `${k.id}${k.status}`).join(".")}`).join(",")}:${E}:${fileSet.size}`;
  if (u.think) return `th:${u.think.id}:${u.think.text.length}:${u.think.active}:${userOpen.get(`th${u.think.id}`)}:${E}`;
  if (u.work) return `w:${u.key}:${userOpen.get(u.key)}:${E}:${u.work.map((x) => unitKey(x, false)).join("|")}`;
  const b = u.b;
  if (b.kind === "tool") return `t${b.id}:${b.status}:${b.ms ?? ""}:${b.result?.length ?? -1}:${!!b.edit}:${userOpen.get(b.id)}:${showAll.has(b.id)}:${a}${E}`;
  if (b.kind === "assistant") return `a${b.id}:${b.text.length}:${b.streaming}:${fileSet.size}`;
  if (b.kind === "user") return `u${b.id}:${b.queued}`;
  if (b.kind === "summary") return `s${b.id}:${fileSet.size}`;
  return `${b.kind}${b.id}`;
}
function unitEl(u, auto) {
  if (u.group) return groupCard(u.group, auto);
  if (u.agents) return agentsCard(u.agents);
  if (u.think) return thinkingItem(u.think);
  if (u.work) return workCard(u.work, u.key);
  return u.b.kind === "tool" ? toolCard(u.b, auto) : blockEl(u.b);
}
function doRender() {
  const sc = $("transcript"), atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  const all = order.map((id) => blocks.get(id)).filter((b) => b && !(b.kind === "tool" && (b.name === "todo_write" || (b.parent && b.agent && b.agent !== "lead"))));
  // One segment per message you sent. Thinking is drawn where it happened: open while it forms, one folded line after.
  const segs = [{ user: null, items: [] }];
  for (const b of all) { if (b.kind === "user" && !b.queued) segs.push({ user: b, items: [] }); else segs.at(-1).items.push(b); }
  const items = [];
  segs.forEach((seg, si) => {
    const live = !!state?.running && si === segs.length - 1;
    if (seg.user) items.push({ u: { b: seg.user } });
    const units = unitsOf(seg.items);
    if (live) {                                                                   // the turn happening now: the newest step is open, earlier steps fold to one line
      let latest = -1; units.forEach((x, k) => { if (isWork(x)) latest = k; });
      units.forEach((x, k) => items.push({ u: x, auto: k === latest && pref("autoOpen", true), step: isWork(x) }));
      return;
    }
    // a finished turn: everything before its answer folds into one "Worked" line; the answer and anything after it stay in full
    let ans = -1; units.forEach((x, k) => { if (x.b && (x.b.kind === "assistant" || x.b.kind === "summary")) ans = k; });
    const before = ans > 0 ? units.slice(0, ans) : [], work = before.filter((x) => isWork(x) || (x.b && x.b.kind === "assistant"));
    if (pref("foldFinished", true) && work.some((x) => !(x.b && x.b.kind === "assistant") && !x.think)) {
      items.push({ u: { work, key: `w${(work[0].b ?? work[0].think ?? work[0].group?.[0] ?? work[0].agents?.[0]).id}` } });
      for (const x of before) if (!work.includes(x)) items.push({ u: x });
      for (const x of units.slice(ans)) items.push({ u: x });
    } else for (const x of units) items.push({ u: x, step: isWork(x) });
  });
  const els = items.map((it) => {
    const key = unitKey(it.u, it.auto);
    let el = cache.get(key);
    if (!el) { el = unitEl(it.u, it.auto); cache.set(key, el); }
    el.__key = key; el.classList.toggle("in-timeline", !!it.step); return el;
  });
  const keep = new Set(els.map((e) => e.__key)); for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
  $("blocks").replaceChildren(...els);
  for (const b of document.querySelectorAll(".thinking.live .body")) b.scrollTop = b.scrollHeight;
  $("empty").classList.toggle("hidden", order.length > 0);
  if (atBottom) sc.scrollTop = sc.scrollHeight;
  updateJump();
}
function blockEl(b) {
  switch (b.kind) {
    case "user": {
      const bubble = h("div", { class: "bubble" }, b.text.split(/(@[^\s@]+)/g).map((part) => (/^@[^\s@]+$/.test(part) ? h("span", { class: "mention", text: part }) : part)));
      if (b.queued) bubble.append(h("span", { class: "tag", text: "queued" }));
      if (b.note) bubble.append(h("span", { class: "note", text: b.note }));
      return h("div", { class: "msg user" }, bubble);
    }
    case "assistant": return h("div", { class: `msg assistant${b.streaming ? " streaming" : ""}` }, md(b.text));
    case "notice": return h("div", { class: `notice ${b.level}`, text: b.text });
    case "summary": return h("div", { class: "summary" }, h("div", { class: "h", text: "✔ Done" }), md(b.text));
    case "raw": {                                                                // what a command printed (/status, /loop, /help…), in its own colours
      const lines = b.lines.slice(b.lines[0] === "" ? 1 : 0);
      return h("div", { class: "rawout" }, ansiLines(lines), h("button", { class: "copy rawcopy", onclick: () => copy(lines.map(stripAnsi).join("\n")) }, "Copy"));
    }
    default: return h("div", { class: "notice", text: JSON.stringify(b) });
  }
}
function updateJump() { const sc = $("transcript"); $("jumpBottom").classList.toggle("hidden", sc.scrollHeight - sc.scrollTop - sc.clientHeight < 200); }
function toBottom() { const sc = $("transcript"); sc.scrollTop = sc.scrollHeight; requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; setTimeout(() => { sc.scrollTop = sc.scrollHeight; updateJump(); }, 120); }); }
$("transcript").addEventListener("scroll", updateJump);
$("jumpBottom").onclick = () => toBottom();

// ------------------------------------------------------------------ server events
function connect() {
  const es = new EventSource(`/events?t=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (m) => { let e; try { e = JSON.parse(m.data); } catch { return; } onServer(e); };
  es.onopen = () => tryApi("/api/scheme", { scheme: lightNow() ? "light" : "dark" });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) { toast("error", "lost the connection to Amness; trying again…"); setTimeout(connect, 1500); } };
}
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyPrefs());
function onServer(e) {
  switch (e.type) {
    case "blocks": blocks.clear(); order = []; cache.clear(); for (const b of e.blocks) { blocks.set(b.id, b); order.push(b.id); } render(true); toBottom(); break;
    case "block": if (!blocks.has(e.block.id)) order.push(e.block.id); blocks.set(e.block.id, e.block); render(); break;
    case "state": { const prev = state; state = e.state; sd = state.sidebar; applyState(prev); break; }
    case "dialog": showDialog(e.dialog); break;
    case "dialogClose": if (dialogOpen === e.id) closeModal(); break;
    case "toast": toast(e.level, stripAnsi(e.text)); break;
    case "fileChanged": onFileChanged(e); break;
    case "copy": copy(e.text); break;
    case "suggestReady": refreshSuggest(); break;
    case "exit": window.close(); break;
  }
}

// ------------------------------------------------------------------ top bar, status line, notifications
let turnStart = 0;
function applyState(prev) {
  const s = state;
  $("projectName").textContent = s.project; $("emptyProject").textContent = s.cwd;
  $("sessionTitle").textContent = s.session.title || "New conversation";
  $("modelName").textContent = s.model; $("modelBtn").title = `${s.providerLabel} · ${s.model}${sd.effort ? ` · effort ${sd.effort}` : ""}`;
  document.querySelector(".model-dot").classList.toggle("off", !s.ready);
  for (const b of $("modeSwitch").children) b.classList.toggle("on", b.dataset.mode === s.mode);
  document.title = `${s.session.title ? s.session.title + " · " : ""}${s.project} · Amness`;
  $("status").classList.toggle("hidden", !s.running && !s.queued.length);
  $("sendBtn").textContent = s.running ? "Queue ↵" : "Send ↵"; $("sendBtn").classList.toggle("queue", s.running);
  $("stopBtn").classList.toggle("hidden", !s.running);
  if (!prev?.running && s.running) turnStart = Date.now();
  if (prev?.running && !s.running) { const ms = Date.now() - turnStart; if (ms > 20000 && !document.hasFocus()) window.amnessDesktop?.notify("Amness finished", `${s.session.title || s.project} · ${fmtDur(ms)}${sd.lastTurnCost != null ? ` · ${fmtCost(sd.lastTurnCost)}` : ""}`); loadFiles(); }
  updateStatus(); renderPanel();
  if (!prev || prev.session.id !== s.session.id || prev.session.turns !== s.session.turns || prev.session.title !== s.session.title) loadSessions();
  if (!prev || prev.cwd !== s.cwd) { loadFiles(); closeViewer(); loadCommands(); }
}
function updateStatus() {
  const s = state; if (!s) return;
  for (const el of document.querySelectorAll(".live-ms")) el.textContent = fmtDur(Date.now() - Number(el.dataset.t0));
  if (!s.running && !s.queued.length) return;
  const now = Date.now(), ph = s.phase, step = ph ? `step ${ph.step + 1}${ph.max ? `/${ph.max}` : ""}` : "";
  const doing = dialogOpen ? "Waiting for you" : ph?.phase === "tools" ? "Running tools" : ph?.phase === "compact" ? "Compacting" : s.mode === "plan" ? "Planning" : "Working";
  const parts = [s.running ? fmtDur(now - s.runStart) : "", s.runTokens ? `↓ ${fmtTokens(s.runTokens)} tokens` : "", step].filter(Boolean);
  $("statusText").replaceChildren(h("b", { text: s.running ? doing + "…" : "Queued" }), h("span", { class: "muted", text: "  " + parts.join(" · ") }), s.runSeries?.length > 1 ? spark(s.runSeries, 80, 14) : "");
  $("statusQueue").replaceChildren(...s.queued.map((q) => h("div", { class: "queued", text: `▸ queued: ${q.replace(/\s+/g, " ").slice(0, 160)}` })));
}
setInterval(() => { updateStatus(); }, 500);

// ------------------------------------------------------------------ the workspace panel (the terminal sidebar's data, drawn as HTML)
// Sections fold; what you fold is remembered. The most used numbers sit in tiles at the top; the rest is one line each.
const FOLDED_BY_DEFAULT = new Set(["Session", "Workspace", "Project", "Skills", "Background", "Plugins"]);
const folded = (title) => pref("fold:" + title, FOLDED_BY_DEFAULT.has(title));
function sec(title, right, ...kids) {
  const f = folded(title);
  return h("section", { class: `psec${f ? " folded" : ""}` },
    h("button", { class: "psec-head", "aria-expanded": String(!f), onclick: () => { setPref("fold:" + title, !f); renderPanel(); } },
      h("span", { class: "chev" }), h("span", { class: "t", text: title }), right ? h("span", { class: "r" }, right) : null),
    f ? null : h("div", { class: "psec-body" }, kids));
}
function kv(pairs) { return h("div", { class: "kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("span", { class: "k", text: k }), h("span", { class: "v" }, v)])); }
const tile = (label, value, sub, cls = "") => h("div", { class: `tile ${cls}` }, h("div", { class: "tv" }, value), h("div", { class: "tl2", text: label }), sub ? h("div", { class: "ts", text: sub }) : null);
function renderPanel() {
  const d = sd, s = state; if (!d) return;
  const out = [], u = d.usage, pct = d.ctxPct ?? 0, cachePct = u.prompt ? Math.round((u.cached / u.prompt) * 100) : 0;
  const b = d.budget && Number.isFinite(d.budget.max) && d.budget.used > 0 ? Math.min(100, Math.round((d.budget.used / d.budget.max) * 100)) : null;
  out.push(h("div", { class: "tiles" },
    tile("context", h("span", {}, `${pct}`, h("small", { text: "%" })), `${fmtTokens(d.ctxUsed)} / ${fmtTokens(d.ctxMax)}`, pct > 85 ? "err" : pct > 60 ? "warn" : ""),
    tile("cost", fmtCost(d.cost).replace(/^\$/, "$"), d.lastTurnCost != null ? `last turn ${fmtCost(d.lastTurnCost)}` : "this conversation"),
    tile("tokens", fmtTokens(u.prompt + u.completion), `${fmtTokens(u.prompt)} in · ${fmtTokens(u.completion)} out`),
    tile("cache", h("span", {}, `${cachePct}`, h("small", { text: "%" })), b !== null ? `budget ${b}%` : `${u.calls} request${u.calls === 1 ? "" : "s"}`, cachePct >= 60 ? "ok" : "")));
  if (s.loop) out.push(sec(s.loop.title === "LOOP" ? "Agent loop" : "Last run", ansi(s.loop.right), h("div", { class: "loop" }, s.loop.lines.map((l, i) => {
    const hit = s.loop.hits.find((x) => x.line === i);
    return h(hit ? "button" : "div", { class: `tl${hit ? " step" : ""}`, onclick: hit ? () => api("/api/step", { n: hit.step }) : undefined }, ansi(l));
  }))));
  if (d.todos?.length) { const done = d.todos.filter((t) => t.status === "done").length; out.push(sec("Todos", `${done}/${d.todos.length}`, h("div", { class: "meter thin" }, h("div", { style: `width:${Math.round((done / d.todos.length) * 100)}%` })), ...d.todos.map((t) => h("div", { class: `todo ${t.status === "done" ? "done" : t.status === "in_progress" ? "doing" : ""}` }, h("span", { class: "ck", text: t.status === "done" ? "✓" : t.status === "in_progress" ? "◐" : "○" }), h("span", { text: t.content }))))); }
  out.push(sec("Changes", d.changes.length ? String(d.changes.length) : "", ...(d.changes.length ? d.changes.map((c) => h("button", { class: "change", title: c.path, onclick: () => openFile(c.path) }, h("span", { class: "p" }, h("span", { class: "dir", text: c.path.slice(0, c.path.length - c.path.split("/").pop().length) }), c.path.split("/").pop()), c.created ? h("span", { class: "new", text: "new" }) : null, h("span", { class: "ad", text: `+${c.added}` }), h("span", { class: "rm", text: `−${c.removed}` })))
    : [h("div", { class: "empty-note", text: "No files changed yet." })]),
    h("div", { class: "row-btns" }, h("button", { class: "btn xs", disabled: !s.session.turns || s.running, onclick: () => run("/rewind") }, "Rewind…"), h("button", { class: "btn xs", disabled: !d.changes.length, onclick: () => run("/diff") }, "Diff"), h("button", { class: "btn xs", disabled: s.running || !s.session.turns, onclick: () => run("/undo") }, "Undo turn"))));
  out.push(sec("Context", d.series?.length > 1 ? `${d.series.length} requests` : "", d.series?.length > 1 ? spark(d.series, 248, 26) : null,
    d.map?.length ? h("div", { class: "ctxbar" }, d.map.filter((m) => m.pct > 0).map((m) => h("span", { title: `${m.label} ${m.pct}%`, style: `width:${m.pct}%;background:${themeColor(m.color)}` }))) : null,
    d.map?.length ? h("div", { class: "ctxmap" }, d.map.filter((m) => m.pct > 0).map((m) => h("div", { class: "cm" }, h("span", { class: "sw", style: `background:${themeColor(m.color)}` }), h("span", { text: m.label }), h("span", { class: "faint", text: `${m.pct}%` })))) : null,
    kv([u.reasoning ? ["reasoning", fmtTokens(u.reasoning)] : null, b !== null ? ["budget", `${b}% of ${fmtTokens(d.budget.max)}`] : null, ["requests", String(u.calls)]])));
  out.push(sec("Session", d.model, kv([["model", d.model], d.api && ["api", d.api], d.effort && ["effort", d.effort], ["branch", d.branch || "no git"], ["mode", { default: "Ask", acceptEdits: "Auto-edit", plan: "Plan", yolo: "Yolo" }[d.mode] || d.mode], d.sandbox && d.sandbox !== "off" && ["sandbox", d.sandbox]])));
  if (d.procs?.length) out.push(sec("Background", String(d.procs.length), ...d.procs.map((p) => h("div", { class: "proc" }, h("span", { class: `dot ${p.status === "running" ? "on" : ""}` }), h("span", { class: "mono", text: p.name }), h("span", { class: "faint", text: `${p.status} · ${p.secs}s` })))));
  if (d.skills?.length) { const used = d.skills.filter((x) => x.uses > 0).length; out.push(sec("Skills", `${used ? used + " used · " : ""}${d.skills.length}`, h("div", { class: "chips" }, d.skills.map((x) => h("button", { class: `chip-s ${x.uses ? "on" : x.off ? "off" : ""}`, title: x.off ? "switched off" : x.uses ? `used ${x.uses}×` : "available", onclick: () => run(`/skills show ${x.name}`) }, x.name, x.uses ? h("span", { class: "n", text: ` ${x.uses}` }) : null))))); }
  if (d.pluginStatus?.length) out.push(sec("Plugins", String(d.pluginStatus.length), ...d.pluginStatus.map((p) => h("div", { class: "small muted", text: p }))));
  out.push(sec("Workspace", `${d.tools} tools`, kv([["tools", String(d.tools)], ["MCP servers", String(d.mcp)], ["memory notes", String(d.memory)]]),
    h("div", { class: "row-btns" }, ["status", "tools", "memory", "mcp", "loop", "tokens"].map((c) => h("button", { class: "btn xs", onclick: () => run("/" + c) }, "/" + c)))));
  out.push(sec("Project", s.project, h("div", { class: "small muted wrap", text: s.cwd }),
    h("div", { class: "row-btns" }, h("button", { class: "btn xs", onclick: openProjectPicker }, "Open another…"), window.amnessDesktop ? h("button", { class: "btn xs", onclick: () => window.amnessDesktop.reveal(s.cwd) }, "Show in folder") : null)));
  if (d.tip) out.push(h("div", { class: "tip" }, h("b", { text: "Tip · " }), d.tip));
  out.push(h("div", { class: "ver", text: `Amness ${s.version} · ${s.providerLabel}` }));
  const scroll = $("panel").scrollTop; $("panel").replaceChildren(...out); $("panel").scrollTop = scroll;
}

// ------------------------------------------------------------------ composer: the terminal's own completion for /commands, their arguments and @files
const input = $("input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; }
let sugg = null, suggT, suggSeq = 0;                     // { token, items, sel }
input.addEventListener("input", () => { autosize(); styleComposer(); clearTimeout(suggT); suggT = setTimeout(refreshSuggest, 60); });
input.addEventListener("click", () => { clearTimeout(suggT); suggT = setTimeout(refreshSuggest, 60); });
function styleComposer() { const v = input.value; $("composer").dataset.kind = v.startsWith("/") ? "command" : v.startsWith("!") ? "shell" : v.startsWith("#") ? "memory" : ""; }
async function refreshSuggest() {
  const text = input.value, cursor = input.selectionStart, seq = ++suggSeq;
  if (!/(^\/|@|\s\/)/.test(text.slice(0, cursor)) && !/^\//.test(text)) { closeSugg(); return; }
  const r = await api("/api/suggest", { text, cursor }).catch(() => null);
  if (seq !== suggSeq || input.value !== text) return;
  if (!r || !r.items?.length) { closeSugg(); return; }
  sugg = { token: r.token, items: r.items.slice(0, 60), sel: 0 }; drawSugg();
}
function drawSugg() {
  const menu = $("mentionMenu");
  if (!sugg) { menu.classList.add("hidden"); return; }
  menu.replaceChildren(...sugg.items.map((it, i) => h("button", { class: `opt${i === sugg.sel ? " on" : ""}`, onmousedown: (e) => { e.preventDefault(); sugg.sel = i; acceptSugg(false); } },
    sugg.token.kind === "file" ? [h("span", { text: it.label.split("/").pop() }), h("span", { class: "d", text: it.label.slice(0, it.label.length - it.label.split("/").pop().length) })] : [h("span", { class: "lab", text: it.label }), it.detail ? h("span", { class: "d", text: it.detail }) : null])));
  menu.classList.remove("hidden"); menu.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function closeSugg() { sugg = null; $("mentionMenu").classList.add("hidden"); }
function acceptSugg(fromEnter) {
  const it = sugg.items[sugg.sel], t = sugg.token, v = input.value, kind = t.kind;
  const text = v.slice(0, t.start) + it.insert + v.slice(t.end), at = t.start + it.insert.length;
  input.value = text; input.setSelectionRange(at, at); closeSugg(); autosize(); styleComposer();
  const cmd = kind === "slash" ? commands.find((c) => "/" + c.name === it.label) : undefined;
  if (fromEnter && ((kind === "slash" && cmd && !cmd.args) || (kind === "arg" && !it.more))) { send(); return; }
  refreshSuggest();
}
const sentHistory = []; let histIdx = -1;
input.addEventListener("keydown", (e) => {
  if (sugg && sugg.items.length) {
    if (e.key === "ArrowDown") { sugg.sel = (sugg.sel + 1) % sugg.items.length; drawSugg(); e.preventDefault(); return; }
    if (e.key === "ArrowUp") { sugg.sel = (sugg.sel + sugg.items.length - 1) % sugg.items.length; drawSugg(); e.preventDefault(); return; }
    if (e.key === "Tab") { acceptSugg(false); e.preventDefault(); return; }
    if (e.key === "Enter" && !e.shiftKey) { const it = sugg.items[sugg.sel], typed = input.value.slice(sugg.token.start, sugg.token.end); if (!(sugg.token.kind === "slash" && input.value.trim() === it.label) && !(sugg.token.kind === "arg" && typed === it.label)) { acceptSugg(true); e.preventDefault(); return; } }
    if (e.key === "Escape") { closeSugg(); e.preventDefault(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing) {
    if (pref("sendKey", "enter") === "mod-enter" && !(e.metaKey || e.ctrlKey)) return;      // Preferences: Enter makes a new line, ⌘/Ctrl+Enter sends
    e.preventDefault(); send(); return;
  }
  if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
  if (e.key === "Escape" && state?.running) { e.preventDefault(); api("/api/stop", {}); return; }
  if (e.key === "ArrowUp" && !input.value.includes("\n") && input.selectionStart === 0 && sentHistory.length) { histIdx = Math.min(sentHistory.length - 1, histIdx + 1); input.value = sentHistory[histIdx]; autosize(); e.preventDefault(); return; }
  if (e.key === "ArrowDown" && histIdx >= 0 && !input.value.includes("\n")) { histIdx--; input.value = histIdx >= 0 ? sentHistory[histIdx] : ""; autosize(); e.preventDefault(); }
});
function send() {
  const text = input.value.trim(); if (!text) return;
  sentHistory.unshift(text); histIdx = -1; input.value = ""; autosize(); closeSugg(); styleComposer();
  run(text);
}
$("sendBtn").onclick = send;
$("stopBtn").onclick = () => api("/api/stop", {});
function cycleMode() { const ms = ["default", "acceptEdits", "plan"], i = ms.indexOf(state?.mode); tryApi("/api/mode", { mode: ms[(i + 1) % ms.length] }); }
for (const b of $("modeSwitch").children) b.onclick = () => { if (b.dataset.mode === "yolo" && state?.mode !== "yolo" && !confirm("Yolo mode runs every edit and command without asking (the built-in safety floor still applies). Turn it on?")) return; tryApi("/api/mode", { mode: b.dataset.mode }); };
async function loadCommands() { commands = (await tryApi("/api/commands")) || []; }

// images: paste, drop, or the button; anything that is not PNG is converted first
async function attachImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  let blob = file;
  if (file.type !== "image/png") { const bmp = await createImageBitmap(file), c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; c.getContext("2d").drawImage(bmp, 0, 0); blob = await new Promise((ok) => c.toBlob(ok, "image/png")); }
  const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
  const res = await tryApi("/api/image", { data: b64 }); if (!res) return;
  const at = input.selectionStart, v = input.value, ins = `${at && !/\s$/.test(v.slice(0, at)) ? " " : ""}@${res.path} `;
  input.value = v.slice(0, at) + ins + v.slice(at); autosize(); input.focus(); toast("ok", "image attached");
}
input.addEventListener("paste", (e) => { for (const it of e.clipboardData?.items || []) if (it.kind === "file" && it.type.startsWith("image/")) { e.preventDefault(); attachImage(it.getAsFile()); return; } });
$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => { attachImage(e.target.files[0]); e.target.value = ""; };
const comp = $("composer");
document.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); comp.classList.add("drop"); } });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) comp.classList.remove("drop"); });
document.addEventListener("drop", (e) => { e.preventDefault(); comp.classList.remove("drop"); for (const f of e.dataTransfer?.files || []) attachImage(f); });

const STARTERS = [["Explain this project", "Explain what this repository does and how it is organised. Keep it short."], ["Find and fix bugs", "Look for likely bugs in this repository and fix the clearest ones, verifying each fix."],
  ["Write tests", "Find the least-tested important code here and add focused tests for it."], ["Write AGENTS.md", "/init"]];
$("starters").replaceChildren(...STARTERS.map(([t, p]) => h("button", { class: "starter", onclick: () => run(p) }, h("b", { text: t }), h("span", { text: p.startsWith("/") ? "Describe this project for future sessions (/init)" : p.split(".")[0] }))));

// ------------------------------------------------------------------ dialogs: the App's own (approvals, pickers, questions, help), drawn as windows
let dialogOpen = null;
function modal(content, o = {}) {
  closeModal(true);
  const ov = h("div", { class: "overlay", onmousedown: (e) => { if (e.target === ov && !o.sticky) { o.onCancel ? o.onCancel() : closeModal(); } } }, content);
  $("modalRoot").append(ov); setTimeout(() => (content.querySelector("[autofocus]") || content.querySelector("input, textarea, .choice, button.primary"))?.focus(), 30); return ov;
}
function closeModal(keepId = false) { $("modalRoot").replaceChildren(); if (!keepId) dialogOpen = null; }
const answer = (id, value) => { api("/api/dialog", { id, value }); closeModal(); };

function showDialog(d) {
  dialogOpen = d.id;
  if (d.kind === "choice") {
    const body = h("div", { class: "body" }), det = d.detail;
    if (det?.kind === "diff") body.append(diffView(det.diff, 800));
    else if (det?.kind === "plan") body.append(md(det.md));
    else if (det?.kind === "command") { body.append(h("pre", { class: "cmd", text: `$ ${det.cmd}` })); if (det.danger) body.append(h("div", { class: "warnbox", text: `⚠ ${det.danger}` })); }
    if (!det || det.kind === "text" || det.kind === "command") { const extra = det?.kind === "command" ? d.body.slice(1) : d.body; if (extra.some((l) => stripAnsi(l).trim())) body.append(ansiLines(extra, "term dialog-term")); }
    body.append(h("div", { class: "question", text: stripAnsi(d.question) }));
    d.options.forEach((o, i) => body.append(h("button", { class: "choice", onclick: () => answer(d.id, i) }, h("span", { class: "num", text: String(i + 1) }), ansi(o.label), o.hint ? h("span", { class: "hint", text: o.hint }) : null)));
    const m = h("div", { class: "modal" }, h("header", {}, h("span", { text: stripAnsi(d.title) })), body, h("footer", {}, h("span", { class: "muted small", text: "1–9 choose · Esc cancel" })));
    m.tabIndex = -1;
    m.addEventListener("keydown", (e) => { const n = Number(e.key); if (n >= 1 && n <= d.options.length) { e.preventDefault(); answer(d.id, n - 1); } else if (e.key === "Escape") { e.preventDefault(); answer(d.id, null); } });
    modal(m, { sticky: true }); dialogOpen = d.id; m.focus();
  } else if (d.kind === "pick") {
    const q = h("input", { type: "search", placeholder: "Type to search", autofocus: true }), list = h("div", { class: "pick-list" }), pv = h("div", { class: "pick-preview hidden" });
    let sel = 0, shown = [], pvFor = -1;
    /** Move the highlight in place. Hovering must not rebuild the list: a click needs the press and the release on the same element. */
    const highlight = (scroll) => {
      [...list.children].forEach((el, k) => el.classList?.toggle("on", k === sel));
      if (scroll) list.children[sel]?.scrollIntoView({ block: "nearest" });
      const cur = shown[sel]?.i;
      if (d.preview && cur !== undefined && cur !== pvFor) { pvFor = cur; api(`/api/dialog-preview?id=${d.id}&i=${cur}`).then((lines) => { if (pvFor !== cur) return; pv.classList.toggle("hidden", !lines.length); pv.replaceChildren(...lines.map((l) => h("div", {}, ansi(l)))); }).catch(() => {}); }
    };
    /** Rebuild the list for the search text. */
    const draw = () => {
      const f = q.value.trim().toLowerCase();
      shown = d.items.map((it, i) => ({ it, i, s: f ? fuzzy(f, stripAnsi(`${it.label} ${it.hint || ""}`)) : 0 })).filter((x) => x.s !== null).sort((a, b) => (f ? b.s - a.s : 0) || a.i - b.i);
      sel = Math.max(0, Math.min(sel, shown.length - 1));
      list.replaceChildren(...shown.map((x, k) => h("button", { class: "opt", onclick: () => answer(d.id, x.i), onmouseenter: () => { if (sel !== k) { sel = k; highlight(false); } } }, h("span", { class: "lab" }, ansi(x.it.label)), x.it.hint ? h("span", { class: "d" }, ansi(x.it.hint)) : null)));
      if (!shown.length) list.append(h("div", { class: "muted small pad", text: "no matches" }));
      highlight(true);
    };
    q.oninput = () => { sel = 0; draw(); };
    q.onkeydown = (e) => { if (e.key === "ArrowDown") { sel = Math.min(shown.length - 1, sel + 1); highlight(true); e.preventDefault(); } else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); highlight(true); e.preventDefault(); } else if (e.key === "Enter") { e.preventDefault(); if (shown[sel]) answer(d.id, shown[sel].i); } else if (e.key === "Escape") { e.preventDefault(); answer(d.id, null); } };
    modal(h("div", { class: "modal narrow" }, h("header", {}, h("span", { text: stripAnsi(d.title) }), h("span", { class: "sub", text: `${d.items.length}` })), h("div", { class: "body" }, q, list, pv), h("footer", {}, h("span", { class: "muted small", text: "↑↓ move · Enter choose · Esc cancel" }))), { onCancel: () => answer(d.id, null) });
    sel = Math.max(0, d.sel || 0); draw(); dialogOpen = d.id;
  } else if (d.kind === "input") {
    const inp = h("input", { type: d.secret ? "password" : "text", value: d.initial || "", autofocus: true, autocomplete: "off" });
    const ok = () => answer(d.id, inp.value);
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } else if (e.key === "Escape") { e.preventDefault(); answer(d.id, null); } };
    modal(h("div", { class: "modal narrow" }, h("header", {}, h("span", { text: stripAnsi(d.prompt) })), h("div", { class: "body" }, inp, h("div", { class: "muted small pad", text: stripAnsi(d.hint) })),
      h("footer", {}, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => answer(d.id, null) }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, "OK"))), { onCancel: () => answer(d.id, null) });
    dialogOpen = d.id;
  } else if (d.kind === "text") {
    const m = h("div", { class: "modal wide" }, h("header", {}, h("span", { text: stripAnsi(d.title).replace(/^./, (c) => c.toUpperCase()) }), h("span", { class: "spacer" }), h("button", { class: "copy", onclick: () => copy(d.lines.map(stripAnsi).join("\n")) }, "Copy")),
      h("div", { class: "body" }, ansiLines(d.lines, "term dialog-term")), h("footer", {}, h("span", { class: "spacer" }), h("button", { class: "btn primary", autofocus: true, onclick: () => answer(d.id, null) }, "Close")));
    m.addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); answer(d.id, null); } });
    modal(m, { onCancel: () => answer(d.id, null) }); dialogOpen = d.id;
  }
}
function popover(anchor, items) {
  closePopover(); const r = anchor.getBoundingClientRect(), p = h("div", { class: "popover", style: `left:${Math.max(8, Math.min(r.left, innerWidth - 430))}px; top:${r.bottom + 6}px` }, items);
  document.body.append(p); setTimeout(() => document.addEventListener("mousedown", closeIfOut), 0);
  function closeIfOut(e) { if (!p.contains(e.target)) { closePopover(); document.removeEventListener("mousedown", closeIfOut); } }
}
function closePopover() { document.querySelectorAll(".popover").forEach((p) => p.remove()); }
const popItem = (text, fn, sub) => h("button", { class: "opt", onclick: () => { closePopover(); fn(); } }, text, sub ? h("span", { class: "faint small", text: "  " + sub }) : null);

function fuzzy(q, s) {
  if (!q) return -s.length; const l = s.toLowerCase(); let i = 0, score = 0, prev = -2;
  for (let k = 0; k < l.length && i < q.length; k++) if (l[k] === q[i]) { score += 1 + (prev === k - 1 ? 3 : 0) + (k === 0 || "/._- ".includes(l[k - 1]) ? 4 : 0); prev = k; i++; }
  if (i < q.length) return null; if (l.includes(q)) score += 20; return score - s.length * 0.02;
}
/** Every command, searchable: the same list as /help and the terminal palette. */
function palette() {
  const q = h("input", { type: "search", placeholder: "Search commands", autofocus: true }), list = h("div", { class: "pick-list" });
  let sel = 0, shown = [];
  const draw = () => {
    const f = q.value.trim().replace(/^\//, "").toLowerCase();
    shown = commands.map((c) => ({ c, s: f ? fuzzy(f, `${c.name} ${c.alias || ""} ${c.help}`) : 0 })).filter((x) => x.s !== null).sort((a, b) => (f ? b.s - a.s : a.c.group.localeCompare(b.c.group) || a.c.name.localeCompare(b.c.name))).map((x) => x.c);
    sel = Math.max(0, Math.min(sel, shown.length - 1)); let grp = "";
    list.replaceChildren(...shown.flatMap((c, k) => { const head = !f && c.group !== grp ? (grp = c.group, [h("div", { class: "grp", text: c.group })]) : []; return [...head, h("button", { class: `opt${k === sel ? " on" : ""}`, onclick: () => pickCmd(c) }, h("span", { class: "mono cmdname", text: "/" + c.name + (c.args ? " " + c.args : "") }), h("span", { class: "d", text: c.help }))]; }));
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };
  const pickCmd = (c) => { closeModal(); if (c.args) { input.value = `/${c.name} `; input.focus(); autosize(); styleComposer(); refreshSuggest(); } else run("/" + c.name); };
  q.oninput = () => { sel = 0; draw(); };
  q.onkeydown = (e) => { if (e.key === "ArrowDown") { sel = Math.min(shown.length - 1, sel + 1); draw(); e.preventDefault(); } else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); } else if (e.key === "Enter" && shown[sel]) { e.preventDefault(); pickCmd(shown[sel]); } else if (e.key === "Escape") closeModal(); };
  modal(h("div", { class: "modal narrow" }, h("header", {}, "Commands", h("span", { class: "sub", text: `${commands.length} · the same as in the terminal` })), h("div", { class: "body" }, q, list))); draw();
}
function quickOpen() {
  const q = h("input", { type: "search", placeholder: "Go to file", autofocus: true }), list = h("div", { class: "pick-list" });
  let sel = 0, shown = [];
  const draw = () => { const f = q.value.trim(); shown = f ? files.map((x) => [fuzzy(f.toLowerCase(), x), x]).filter((x) => x[0] !== null).sort((a, b) => b[0] - a[0]).slice(0, 60).map((x) => x[1]) : files.slice(0, 60); sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((p, i) => h("button", { class: `opt${i === sel ? " on" : ""}`, onclick: () => { closeModal(); openFile(p); } }, h("span", { class: "mono", text: p })))); list.querySelector(".on")?.scrollIntoView({ block: "nearest" }); };
  q.oninput = () => { sel = 0; draw(); };
  q.onkeydown = (e) => { if (e.key === "ArrowDown") { sel = Math.min(shown.length - 1, sel + 1); draw(); e.preventDefault(); } else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); } else if (e.key === "Enter" && shown[sel]) { closeModal(); openFile(shown[sel]); } else if (e.key === "Escape") closeModal(); };
  modal(h("div", { class: "modal narrow" }, h("div", { class: "body pt" }, q, list))); draw();
}
function findBar() {
  let bar = $("findbar");
  if (!bar) {
    const q = h("input", { type: "search", placeholder: "Find in conversation", autofocus: true });
    bar = h("div", { id: "findbar", class: "findbar" }, q, h("button", { class: "icon-btn", title: "Previous", onclick: () => window.find(q.value, false, true, true) }, "↑"), h("button", { class: "icon-btn", title: "Next", onclick: () => window.find(q.value, false, false, true) }, "↓"), h("button", { class: "icon-btn", onclick: () => bar.remove() }, "✕"));
    q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); window.find(q.value, false, e.shiftKey, true); q.focus(); } else if (e.key === "Escape") bar.remove(); };
    $("main").append(bar);
  }
  bar.querySelector("input").focus(); bar.querySelector("input").select();
}
function modelMenu() {
  popover($("modelBtn"), [h("div", { class: "head", text: `${state?.providerLabel ?? ""} · ${state?.model ?? ""}` }),
    popItem("Change model…", () => run("/model")), popItem("Reasoning effort…", () => run("/effort"), sd?.effort || "default"), popItem("Providers and API keys…", () => run("/connect")), popItem("Switch provider…", () => run("/provider")),
    h("div", { class: "sep" }), popItem("Models for roles (explore, review…)", () => run("/models")), popItem("Fallback model", () => run("/models")), popItem("Budget…", () => run("/budget")), popItem("Token use", () => run("/tokens")), popItem("Cache", () => run("/cache"))]);
}
function renameSession() {
  const inp = h("input", { type: "text", value: state?.session.title || "", autofocus: true });
  const save = () => { closeModal(); run(`/rename ${inp.value}`); };
  inp.onkeydown = (e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") closeModal(); };
  modal(h("div", { class: "modal narrow" }, h("header", {}, "Rename conversation"), h("div", { class: "body" }, inp), h("footer", {}, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => closeModal() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, "Rename"))));
  setTimeout(() => inp.select(), 40);
}
async function openProjectPicker() {
  if (window.amnessDesktop) { const dir = await window.amnessDesktop.pickFolder(); if (dir) await switchProject(dir); return; }
  const inp = h("input", { type: "text", placeholder: "/path/to/project", autofocus: true });
  const go = async () => { if (inp.value.trim()) { closeModal(); await switchProject(inp.value.trim()); } };
  inp.onkeydown = (e) => { if (e.key === "Enter") go(); };
  modal(h("div", { class: "modal narrow" }, h("header", {}, "Open a project folder"), h("div", { class: "body" }, inp), h("footer", {}, h("span", { class: "spacer" }), h("button", { class: "btn primary", onclick: go }, "Open"))));
}
async function switchProject(dir) { if (state?.running) { toast("warn", "stop the running turn first"); return; } if (await tryApi("/api/project", { dir })) toast("ok", `opened ${dir.split(/[\\/]/).pop()}`); }
async function projectMenu() {
  const recent = ((await tryApi("/api/projects")) || []).filter((p) => p !== state?.cwd);
  popover($("projectBtn"), [popItem("Open folder…", openProjectPicker),
    ...(recent.length ? [h("div", { class: "sep" }), h("div", { class: "head", text: "Recent" }), ...recent.map((p) => popItem(p.split(/[\\/]/).pop(), () => switchProject(p), p))] : []),
    h("div", { class: "sep" }), popItem("Write AGENTS.md (/init)", () => run("/init")), popItem("Hooks", () => run("/hooks")), popItem("Permissions", () => run("/permissions")), popItem("Plugins", () => run("/plugins")), popItem("Agents", () => run("/agents")),
    ...(window.amnessDesktop && state ? [h("div", { class: "sep" }), popItem("Show in folder", () => window.amnessDesktop.reveal(state.cwd))] : [])]);
}

// ------------------------------------------------------------------ conversations (sidebar)
async function loadSessions() {
  const list = (await tryApi(`/api/sessions?q=${encodeURIComponent($("sessionSearch").value)}`)) || [];
  $("sessionList").replaceChildren(h("button", { class: `item${state && !state.session.turns ? " on" : ""}`, onclick: () => newChat() }, h("div", { class: "t", text: "✎ New conversation" })),
    ...list.map((s) => h("button", { class: `item${s.id === state?.session.id ? " on" : ""}`, title: s.title, onmouseenter: () => showPreview(s.id), onclick: () => resume(s.id) },
      h("div", { class: "t", text: s.title || "(untitled)" }), h("div", { class: "m", text: `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${ago(s.updated)} · ${s.model}` }))));
}
let previewTimer, previewFor = null;
function showPreview(id) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (previewFor === id) return; previewFor = id; const lines = (await tryApi(`/api/preview?id=${encodeURIComponent(id)}`)) || [];
    const p = $("sessionPreview"); p.classList.toggle("hidden", !lines.length);
    p.replaceChildren(...lines.map((l) => { const i = l.indexOf("  "); return h("div", {}, h("b", { text: l.slice(0, i) + " " }), l.slice(i + 2).slice(0, 240)); }));
  }, 150);
}
async function resume(id) { if (id === state?.session.id) return; if (state?.running) { toast("warn", "wait for the current turn to finish (or stop it)"); return; } if (await tryApi("/api/resume", { id })) input.focus(); }
async function newChat() { if (state?.running) { toast("warn", "wait for the current turn to finish (or stop it)"); return; } if (await tryApi("/api/new", {})) input.focus(); }
let searchT; $("sessionSearch").oninput = () => { clearTimeout(searchT); searchT = setTimeout(loadSessions, 150); };

// ------------------------------------------------------------------ files (sidebar tree and the live file view)
const openDirs = new Set([""]);
async function loadFiles() { files = (await tryApi("/api/files")) || []; fileSet = new Set(files); drawTree(); render(true); }
function drawTree() {
  const box = $("fileTree"), f = $("fileFilter").value.trim().toLowerCase(), changed = new Set((sd?.changes || []).map((c) => c.path));
  if (f) {
    const hits = files.map((x) => [fuzzy(f, x), x]).filter((x) => x[0] !== null).sort((a, b) => b[0] - a[0]).slice(0, 200).map((x) => x[1]);
    box.replaceChildren(...hits.map((p) => h("button", { class: `node${p === viewerPath ? " on" : ""}`, title: p, onclick: () => openFile(p) }, h("span", { class: "ic", text: "·" }), h("span", { class: "nm", text: p }), changed.has(p) ? h("span", { class: "badge", text: "M" }) : null)));
    return;
  }
  const tree = { dirs: new Map(), files: [] };
  for (const p of files) { const parts = p.split("/"); let n = tree; for (const d of parts.slice(0, -1)) { if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] }); n = n.dirs.get(d); } n.files.push(p); }
  const rows = [];
  const walk = (n, prefix, depth) => {
    for (const [name, d] of [...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = prefix + name + "/", open = openDirs.has(path), hasChange = [...changed].some((c) => c.startsWith(path));
      rows.push(h("button", { class: "node dir", style: `padding-left:${8 + depth * 14}px`, onclick: () => { open ? openDirs.delete(path) : openDirs.add(path); drawTree(); } }, h("span", { class: "ic", text: open ? "▾" : "▸" }), h("span", { class: "nm", text: name }), hasChange ? h("span", { class: "badge", text: "●" }) : null));
      if (open) walk(d, path, depth + 1);
    }
    for (const p of n.files.sort()) rows.push(h("button", { class: `node${p === viewerPath ? " on" : ""}`, style: `padding-left:${8 + depth * 14}px`, title: p, onclick: () => openFile(p) }, h("span", { class: "ic", text: "" }), h("span", { class: "nm", text: p.split("/").pop() }), changed.has(p) ? h("span", { class: "badge", text: "M" }) : null));
  };
  walk(tree, "", 0);
  if (!rows.length) rows.push(h("div", { class: "muted small pad", text: "No files found." }));
  box.replaceChildren(...rows);
}
$("fileFilter").oninput = drawTree;
async function openFile(path, line) {
  viewerPath = path; $("app").classList.add("viewer-open"); $("viewer").classList.remove("hidden");
  $("viewerPath").textContent = path; $("viewerMeta").textContent = "";
  const code = $("viewerCode"); code.replaceChildren(h("div", { class: "msg-line", text: "loading…" }));
  let f; try { f = await api(`/api/file?path=${encodeURIComponent(path)}`); } catch (e) { code.replaceChildren(h("div", { class: "msg-line", text: e.message })); return; }
  if (viewerPath !== path) return;
  const marks = changedLines.get(path) || new Set(), lines = f.text.split("\n"); if (lines.at(-1) === "") lines.pop();
  $("viewerMeta").textContent = `${lines.length} lines${marks.size ? ` · ${marks.size} changed this session` : ""}`;
  const frag = document.createDocumentFragment();
  lines.forEach((l, i) => frag.append(h("div", { class: `ln${marks.has(i + 1) ? " changed" : ""}`, id: `L${i + 1}` }, h("span", { class: "n", text: String(i + 1) }), h("span", { text: l || " " }))));
  code.replaceChildren(frag);
  const target = line ?? [...marks].sort((a, b) => a - b)[0];
  if (target) document.getElementById(`L${target}`)?.scrollIntoView({ block: "center" }); else code.scrollTop = 0;
  drawTree();
}
function closeViewer() { viewerPath = null; $("app").classList.remove("viewer-open"); $("viewer").classList.add("hidden"); drawTree(); }
$("viewerClose").onclick = closeViewer;
$("viewerEditor").onclick = () => { if (viewerPath) tryApi("/api/open-file", { path: viewerPath, line: [...(changedLines.get(viewerPath) || [])][0] || 1 }); };
$("viewerMention").onclick = () => { if (!viewerPath) return; const at = input.selectionStart, v = input.value, ins = `${at && !/\s$/.test(v.slice(0, at)) ? " " : ""}@${viewerPath} `; input.value = v.slice(0, at) + ins + v.slice(at); autosize(); input.focus(); };
function onFileChanged(e) {
  if (e.diff) { const s = changedLines.get(e.path) || new Set(); for (const n of addedLines(e.diff)) s.add(n); changedLines.set(e.path, s); }
  if (!fileSet.has(e.path)) { files.push(e.path); files.sort(); fileSet.add(e.path); }
  if (viewerPath === e.path) openFile(e.path);
  drawTree();
}

// ------------------------------------------------------------------ Preferences
// Appearance and chat behaviour are the window's own (saved with setPref). Agent settings run the same terminal command you would type (/sandbox workspace…),
// quietly, so the terminal and the desktop share one implementation and one config file.
let prefsTab = "appearance";
const sw = (on, onChange) => { const b = h("button", { class: `switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(on) }); b.onclick = () => { const v = !b.classList.contains("on"); b.classList.toggle("on", v); b.setAttribute("aria-checked", String(v)); onChange(v); }; return b; };
const seg = (opts, cur, onChange) => { const box = h("div", { class: "seg" }); for (const [v, l] of opts) box.append(h("button", { class: v === cur ? "on" : "", onclick: () => { for (const x of box.children) x.classList.toggle("on", x === box.children[opts.findIndex((o) => o[0] === v)]); onChange(v); } }, l)); return box; };
const sel = (opts, cur, onChange) => { const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v, ...(v === cur ? { selected: true } : {}) }, l))); s.onchange = () => onChange(s.value); return s; };
const txt = (cur, ph, onChange) => { const i = h("input", { type: "text", value: cur ?? "", placeholder: ph }); const fire = () => { if (i.value !== (i.dataset.last ?? cur ?? "")) { i.dataset.last = i.value; onChange(i.value.trim()); } }; i.onkeydown = (e) => { if (e.key === "Enter") fire(); }; i.onblur = fire; return i; };
const range = (min, max, step, cur, fmt, onChange) => { const v = h("span", { class: "val", text: fmt(cur) }), r = h("input", { type: "range", min, max, step, value: cur }); r.oninput = () => { v.textContent = fmt(Number(r.value)); onChange(Number(r.value)); }; return [r, v]; };
const row = (label, desc, ...ctl) => h("div", { class: "pref" }, h("div", { class: "pl", text: label }), desc ? h("div", { class: "pd", text: desc }) : null, h("div", { class: "pc" }, ctl));
/** Run a setting's terminal command quietly and say what it answered. */
async function setting(cmd) { try { const r = await api("/api/command", { text: cmd }); if (r.lines?.length) toast("ok", r.lines[0].slice(0, 160)); } catch (e) { toast("error", e.message); } }
const onoff = (v) => (v ? "on" : "off");

async function showPrefs() {
  const s = (await tryApi("/api/settings")) || {};
  const nav = h("nav", { class: "prefs-nav" }), body = h("div", { class: "prefs-body" });
  const TABS = [["appearance", "◐", "Appearance"], ["chat", "✉", "Chat"], ["model", "◆", "Model"], ["safety", "⛨", "Safety & quality"], ["advanced", "⚙", "Advanced"], ["about", "ⓘ", "About"]];
  const draw = () => {
    nav.replaceChildren(...TABS.map(([id, ic, l]) => h("button", { class: id === prefsTab ? "on" : "", onclick: () => { prefsTab = id; draw(); } }, h("span", { class: "ic", text: ic }), l)));
    const P = (k, d) => pref(k, d), set = (k) => (v) => { setPref(k, v); applyPrefs(); render(true); };
    const sections = {
      appearance: [h("h2", { text: "Appearance" }), h("div", { class: "lead", text: "How the window looks. Changes apply at once." }),
        row("Theme", "Follow the system, or always dark or light.", seg([["system", "System"], ["dark", "Dark"], ["light", "Light"]], P("theme", "system"), set("theme"))),
        row("Accent colour", "Buttons, selection and the active step.", h("div", { class: "swatches" }, Object.entries(ACCENTS).map(([name, c]) => h("button", { class: `swatch${P("accent", "violet") === name ? " on" : ""}`, title: name, style: `background:${c[0]}`, onclick: (e) => { setPref("accent", name); applyPrefs(); for (const x of e.currentTarget.parentElement.children) x.classList.toggle("on", x === e.currentTarget); } })))),
        row("Interface size", "Scales the whole window.", ...range(0.8, 1.3, 0.05, P("uiScale", 1), (v) => `${Math.round(v * 100)}%`, set("uiScale"))),
        row("Chat text size", "Replies, your messages and the message box.", ...range(12, 18, 1, P("chatSize", 14), (v) => `${v}px`, set("chatSize"))),
        row("Code font", "Used for code, diffs, commands and the file view. Leave empty for the system font.", txt(P("codeFont", ""), "e.g. JetBrains Mono", set("codeFont"))),
        row("Density", "Compact fits more on the screen.", seg([["comfortable", "Comfortable"], ["compact", "Compact"]], P("density", "comfortable"), set("density"))),
        row("Reduce motion", "No animations or pulsing.", sw(!!P("reduceMotion", false), set("reduceMotion")))],
      chat: [h("h2", { text: "Chat" }), h("div", { class: "lead", text: "How conversations behave in this window." }),
        row("Start in mode", "The permission mode a new window starts with.", sel([["default", "Ask"], ["acceptEdits", "Auto-edit"], ["plan", "Plan"]], P("defaultMode", "default"), (v) => setPref("defaultMode", v))),
        row("Send with", "With ⌘/Ctrl+Enter, Enter starts a new line.", seg([["enter", "Enter"], ["mod-enter", "⌘/Ctrl+Enter"]], P("sendKey", "enter"), (v) => setPref("sendKey", v))),
        row("Fold finished turns", "A finished turn's steps become one \"Worked …\" line; the answer stays in full.", sw(P("foldFinished", true) !== false, set("foldFinished"))),
        row("Open the current step", "While Amness works, the step happening now opens by itself.", sw(P("autoOpen", true) !== false, set("autoOpen"))),
        row("Notifications", "When a long turn ends or approval is needed while the window is in the background.", sw(s.notify !== false, (v) => setting(`/notify ${onoff(v)}`)))],
      model: [h("h2", { text: "Model" }), h("div", { class: "lead", text: `${s.providerLabel ?? ""} · ${s.model ?? ""}` }),
        row("Provider and API keys", "Connect providers, add or replace keys.", h("button", { class: "btn small", onclick: () => { closeModal(); run("/connect"); } }, "Manage…")),
        row("Model", s.model ?? "", h("button", { class: "btn small", onclick: () => { closeModal(); run("/model"); } }, "Change…")),
        ...(s.efforts?.length ? [row("Reasoning effort", "More effort thinks longer and costs more.", sel([["default", "Default"], ...s.efforts.map((x) => [x, x])], s.effort || "default", (v) => setting(`/effort ${v}`)))] : []),
        row("Budget per turn", "Token cap for one turn (cached input counts a tenth). For example 300k or 1m.", txt(s.maxTokens ? fmtTokens(s.maxTokens) : "", "300k", (v) => v && setting(`/budget ${v}`))),
        row("Fallback model", "Answers when the main model is overloaded or unreachable.", txt(s.fallback, "model id, or empty for none", (v) => setting(`/models fallback ${v || "off"}`))),
        ...["explore", "compact", "review", "cheap"].map((r) => row(`Model for ${r}`, { explore: "The read-only explorer subagents.", compact: "Handoff notes and /compact.", review: "The independent reviewer.", cheap: "Cheap steps when the router is on." }[r], txt(s.models?.[r], "same as the main model", (v) => setting(`/models ${r} ${v || "off"}`)))),
        row("Router", "Send exploration steps to the cheap model when that pays off.", sw(!!s.router, (v) => setting(`/router ${onoff(v)}`))),
        ...(s.openai ? [row("Wire API", "OpenAI-compatible providers only.", sel([["auto", "Auto"], ["responses", "Responses"], ["chat", "Chat completions"]], s.api, (v) => setting(`/api ${v}`)))] : [])],
      safety: [h("h2", { text: "Safety & quality" }), h("div", { class: "lead", text: "What protects your machine and what checks the work." }),
        row("Sandbox", "Shell commands run in an OS sandbox: workspace (no writes outside the project) or strict (no network either).", sel([["off", "Off"], ["workspace", "Workspace"], ["strict", "Strict"]], s.sandbox, (v) => setting(`/sandbox ${v}`))),
        row("Verify command", "Must pass before Amness may say it is done (for example npm test).", txt(s.verify, "none", (v) => setting(`/verify ${v || "off"}`))),
        row("Check after each edit", "A fast command (typecheck, lint) whose failures go straight back to the model.", txt(s.check, "none", (v) => setting(`/check ${v || "off"}`))),
        row("Language-server errors", "Add errors from an installed language server to edit results.", sw(!!s.lsp, (v) => setting(`/lsp ${onoff(v)}`))),
        row("Independent reviewer", "A skeptical second pass before work is accepted (extra model calls).", sw(!!s.review, (v) => setting(`/reviewer ${onoff(v)}`))),
        row("Approval reviewer", "A second model pre-approves clearly safe risky calls (never the safety floor).", sw(!!s.approvalReviewer, (v) => setting(`/approver ${onoff(v)}`)))],
      advanced: [h("h2", { text: "Advanced" }), h("div", { class: "lead", text: "Rarely needed." }),
        row("Shell", "Which shell runs the agent's commands.", sel((s.shells ?? ["auto"]).map((x) => [x, x]), s.shell, (v) => setting(`/shell ${v}`))),
        row("Loop strategy", "Plan first, explore then act, or none.", sel((s.strategies ?? ["off"]).map((x) => [x, x]), s.strategy, (v) => setting(`/strategy ${v}`))),
        row("Keep the cache warm", "While you are away, keep the prompt cache alive (a few cache reads).", sw(!!s.keepWarm, (v) => setting(`/keepwarm ${onoff(v)}`))),
        row("Plan cache", "Offer the plan of a similar finished task as a starting point.", sw(!!s.plans, (v) => setting(`/plans ${onoff(v)}`))),
        row("All settings", `Everything is kept in ${s.configFile ?? "~/.amness/config.json"}, shared with the terminal app.`, h("button", { class: "btn small", onclick: () => { closeModal(); palette(); } }, "All commands…"))],
      about: [h("div", { class: "about" }, h("img", { src: "icon.png", alt: "" }), h("div", {}, h("h3", { text: "Amness" }), h("div", { class: "muted", text: `Version ${state?.version ?? ""}` }), h("div", { class: "muted small", text: navigator.userAgent.match(/Electron\/[\d.]+/)?.[0]?.replace("/", " ") ?? "browser" }))),
        row("Project", state?.cwd ?? "", window.amnessDesktop && state ? h("button", { class: "btn small", onclick: () => window.amnessDesktop.reveal(state.cwd) }, "Show in folder") : null),
        row("Shortcuts", "⌘/Ctrl K commands · N new · O open · P file · F find · E expand · B sidebar · J panel · , preferences", null)],
    };
    body.replaceChildren(...sections[prefsTab]);
  };
  draw();
  modal(h("div", { class: "modal prefs" }, h("header", {}, "Preferences", h("span", { class: "spacer" }), h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => closeModal() }, "✕")), h("div", { class: "prefs-wrap" }, nav, body)));
}

// ------------------------------------------------------------------ chrome: buttons, tabs, shortcuts, menus
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => {
  for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
  $("chatsTab").classList.toggle("hidden", b.dataset.tab !== "chats"); $("filesTab").classList.toggle("hidden", b.dataset.tab !== "files");
  if (b.dataset.tab === "files") $("fileFilter").focus();
};
// On a wide window the side columns are part of the layout and your choice is remembered; on a narrow one they are drawers over the chat that start closed.
const narrowFor = { "panel-open": matchMedia("(max-width: 1280px)"), "sidebar-open": matchMedia("(max-width: 1000px)") };
const toggle = (cls, on) => {
  const v = on ?? !$("app").classList.contains(cls); $("app").classList.toggle(cls, v);
  if (!narrowFor[cls]?.matches) setPref(cls, v);
};
function applyLayout() { for (const cls of ["sidebar-open", "panel-open"]) $("app").classList.toggle(cls, narrowFor[cls].matches ? false : pref(cls, true)); }
for (const cls of ["sidebar-open", "panel-open"]) narrowFor[cls].addEventListener("change", (e) => $("app").classList.toggle(cls, e.matches ? false : pref(cls, true)));
$("scrimPanel").onclick = () => toggle("panel-open", false);
$("scrimSide").onclick = () => toggle("sidebar-open", false);
const setExpandAll = (v) => { expandAll = v; $("expandBtn").classList.toggle("on", v); cache.clear(); render(true); };
$("toggleSidebar").onclick = () => toggle("sidebar-open");
$("togglePanel").onclick = () => toggle("panel-open");
$("expandBtn").onclick = () => setExpandAll(!expandAll);
$("paletteBtn").onclick = palette;
$("newBtn").onclick = newChat;
$("modelBtn").onclick = modelMenu;
$("titleBtn").onclick = renameSession;
$("projectBtn").onclick = projectMenu;
$("prefsBtn").onclick = () => showPrefs();
const menuAction = (what) => ({ prefs: () => showPrefs(), new: newChat, open: openProjectPicker, file: quickOpen, sidebar: () => toggle("sidebar-open"), panel: () => toggle("panel-open"), expand: () => setExpandAll(!expandAll), find: findBar, palette })[what]?.();
window.amnessDesktop?.onMenu(menuAction);
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape" && $("modalRoot").children.length && !dialogOpen) { closeModal(); return; }
  if (e.key === "Escape" && state?.running && document.activeElement !== input && !dialogOpen) { api("/api/stop", {}); return; }
  if (!mod || window.amnessDesktop) return;                                       // in the app window the menu owns these shortcuts
  if (e.key === ",") { e.preventDefault(); showPrefs(); return; }
  const map = { n: "new", o: "open", p: "file", b: "sidebar", j: "panel", e: "expand", f: "find", k: "palette" }, k = map[e.key.toLowerCase()];
  if (k) { e.preventDefault(); menuAction(k); }
});
if (window.amnessDesktop && /Mac/.test(navigator.platform)) document.documentElement.classList.add("mac-electron");

// ------------------------------------------------------------------ start
if (!TOKEN) document.body.replaceChildren(h("div", { class: "empty" }, h("h1", { text: "Open Amness with the amness-desktop command." }), h("p", { class: "muted", text: "This page needs the access link that the command opens." })));
else api("/api/prefs").then((p) => { prefs = p || {}; }, () => {}).finally(() => { applyPrefs(); applyLayout(); connect(); input.focus(); });
