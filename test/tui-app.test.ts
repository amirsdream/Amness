import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { KEY, call, gate, plain, rig, say, sleep } from "./helpers/apprig.ts";

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

test("app boots with welcome, a pinned input box and footer", async () => {
  const t = rig([]); await t.start();
  const s = t.screen();
  assert.match(s, /welcome/); assert.match(s, /test-model/); assert.match(s, /\/help for commands/);
  assert.match(s, /❯/); assert.match(s, /\? for shortcuts/); assert.equal(count(t.text(), "? for shortcuts"), 1);
  const last = t.vt.screen().slice(-4);
  assert.ok(/^─+$/.test(last[0]) && last[1].startsWith("❯") && /^─+$/.test(last[2]), JSON.stringify(last));      // rule, input, rule, footer pinned at the bottom
  await t.key(KEY.ctrlD); assert.equal(await t.app.done, 0);
});

test("typing, editing and sending: user message and a streamed markdown reply land in scrollback; one input box remains", async () => {
  const t = rig([say("Sure! Here is **bold** and `code`.\n\nSecond paragraph.")]); await t.start();
  await t.type("hello wrld"); await t.key(KEY.left); await t.key(KEY.left); await t.key(KEY.left); await t.type("o"); 
  assert.match(t.screen(), /❯ hello world/);
  await t.key(KEY.enter);
  assert.ok(await t.until(() => t.has("Second paragraph.") && t.idle()));
  const all = t.text();
  assert.match(all, /❯ hello world/); assert.match(all, /● Sure! Here is bold and code\./); assert.match(all, /\n {2}Second paragraph\./);
  assert.equal(count(all, "Second paragraph."), 1);                                       // streamed text is committed exactly once
  assert.equal(count(all, "? for shortcuts"), 1, "only one live region");
  assert.equal(t.vt.screen().filter((l) => /^─+$/.test(l)).length, 2);
  assert.equal(t.seen[0].msgs.at(-1)!.content, "hello world");
  await t.key(KEY.ctrlD);
});

test("streaming: the unfinished paragraph is visible live before the turn completes", async () => {
  const g = gate();
  const t = rig([async (_m, _t, o) => { o.onText?.("First paragraph is done.\n\nSecond is still being wri"); await g.p; o.onText?.("tten."); return say("First paragraph is done.\n\nSecond is still being written."); }]); await t.start();
  await t.submit("go");
  assert.ok(await t.until(() => t.has("Second is still being wri")));
  assert.ok(t.has("First paragraph is done.") && !t.has("written."));
  assert.match(t.screen(), /Working/); assert.match(t.screen(), /esc to interrupt/);          // live status while running
  g.open();
  assert.ok(await t.until(() => t.has("being written.") && t.idle()));
  assert.equal(count(t.text(), "Second is still being wri"), 1);
  await t.key(KEY.ctrlD);
});

test("tool calls render as '● Tool(args)' with a summarised result; file reads are not dumped", async () => {
  const t = rig([call("read_file", { path: "a.txt" }, "Let me look."), call("sh", { cmd: "ls" }), say("Done.")]); await t.start();
  await t.submit("inspect");
  assert.ok(await t.until(() => t.idle() && t.has("Done.")));
  const all = plain(t.text());
  assert.match(all, /● Read\(a\.txt\)\n\s+⎿\s+Read 2 lines/); assert.match(all, /● Bash\(ls\)/); assert.ok(!all.includes("1\tone"));
  assert.match(all, /● Let me look\./);
  await t.key(KEY.ctrlD);
});

test("edits ask first (default mode) with a diff; Enter applies and the diff is shown with line numbers", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "two", new: "2" }), say("Edited.")]); await t.start();
  await t.submit("change two to 2");
  assert.ok(await t.until(() => t.has("Apply this change?")));
  const s = plain(t.screen());
  assert.match(s, /Edit a\.txt/); assert.match(s, /- two/); assert.match(s, /\+ 2/); assert.match(s, /1\. Yes/); assert.match(s, /accept all edits this session/);
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "one\ntwo\n");                      // nothing written yet
  await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle() && t.has("Edited.")));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "one\n2\n");
  const all = plain(t.text());
  assert.match(all, /● Update\(a\.txt\)\n\s+⎿\s+Added 1 line, removed 1 line/); assert.match(all, /2 - two/); assert.match(all, /2 \+ 2/);
  await t.key(KEY.ctrlD);
});

test("denying with a note: the model is told what the user wants instead; nothing is written", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), call("write_file", { path: "a.txt", content: "x" }), (m) => say("ok")]); await t.start();
  await t.submit("overwrite a.txt");
  assert.ok(await t.until(() => t.has("Apply this change?")));
  await t.key("3");                                                                          // "No, and tell Amness what to do instead"
  assert.ok(await t.until(() => t.has("What should Amness do instead?")));
  await t.type("append instead of overwriting"); await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle()));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "one\ntwo\n");
  const denial = t.seen.at(-1)!.msgs.filter((m) => m.role === "tool").at(-1)!.content!;
  assert.match(denial, /DENIED: append instead of overwriting/);
  await t.key(KEY.ctrlD);
});

test("shift+tab cycles permission modes; accept-edits applies edits without asking", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), call("edit_file", { path: "a.txt", old: "one", new: "1" }), say("done")]); await t.start();
  await t.key(KEY.backtab);
  assert.match(t.screen(), /accept edits on/);
  await t.submit("edit");
  assert.ok(await t.until(() => t.idle()));
  assert.ok(!t.has("Apply this change?")); assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "1\ntwo\n");
  await t.key(KEY.backtab); assert.match(t.screen(), /plan mode/); await t.key(KEY.backtab); assert.ok(!/plan mode|accept edits on/.test(t.screen()));
  await t.key(KEY.ctrlD);
});

test("shell commands ask once, 'don't ask again for <prefix>' covers later ones; read-only commands never ask", async () => {
  const t = rig([call("sh", { cmd: "ls" }), call("sh", { cmd: "printf one" }), call("sh", { cmd: "printf two" }), say("fin")]);
  const prompts: string[] = []; const real = t.app.approve; t.app.approve = async (r) => (prompts.push(r.args.cmd), real(r)); t.app.buildAgent();
  await t.start();
  await t.submit("run things");
  assert.ok(await t.until(() => t.has("Run this command?")));
  assert.match(plain(t.screen()), /printf one/); assert.match(plain(t.screen()), /don't ask again for printf commands/);
  await t.key("2");
  assert.ok(await t.until(() => t.idle()));
  assert.deepEqual(prompts.filter((c) => c !== "ls"), ["printf one", "printf two"]);          // both reached the gate...
  assert.equal(t.app.shRules.has("printf"), true);                                           // ...but only the first needed a human
  assert.match(plain(t.text()), /● Bash\(printf two\)/);
  await t.key(KEY.ctrlD);
});

test("plan mode: writers are hidden, exit_plan_mode shows the plan and approval switches to accept-edits", async () => {
  const t = rig([call("write_file", { path: "z", content: "" }), call("exit_plan_mode", { plan: "## Plan\n1. change a.txt\n2. run tests" }), (m, tools) => say("implementing")]); await t.start();
  await t.key(KEY.backtab); await t.key(KEY.backtab);
  await t.submit("plan it");
  assert.ok(await t.until(() => t.has("Ready to code?")));
  assert.ok(!t.seen[0].tools.includes("write_file") && t.seen[0].tools.includes("exit_plan_mode"));
  assert.match(plain(t.screen()), /Plan/); assert.match(plain(t.screen()), /change a\.txt/); assert.match(plain(t.screen()), /accept edits automatically/);
  await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle()));
  assert.match(t.screen(), /accept edits on/); assert.ok(t.seen.at(-1)!.tools.includes("write_file"));
  assert.match(t.seen.at(-1)!.msgs.filter((m) => m.role === "tool").at(-1)!.content!, /approved the plan/);
  await t.key(KEY.ctrlD);
});

test("slash commands: popup while typing, Tab completes, Enter runs; /help overlay closes on any key", async () => {
  const t = rig([]); await t.start();
  await t.type("/mo");
  assert.match(plain(t.screen()), /❯ \/mode\s+permissions/); assert.match(plain(t.screen()), /\/model\s+switch model/);
  await t.key(KEY.down); await t.key(KEY.tab); assert.match(t.screen(), /^❯ \/model\s*$/m);
  await t.key("\x15");                                                                       // ctrl-u clears the line
  await t.type("/hel"); await t.key(KEY.enter);
  assert.ok(await t.until(() => t.vt.altActive));
  assert.match(plain(t.screen()), /Keys[\s\S]*Shift\+Tab[\s\S]*Commands/); assert.match(plain(t.screen()), /help · /);       // scrollable pager: nothing is clipped
  await t.key("q"); assert.equal(t.vt.altActive, false); assert.match(t.screen(), /^❯/m);
  await t.type("/nope"); await t.key(KEY.esc); await t.key(KEY.enter);
  assert.match(t.text(), /unknown command \/nope/);
  await t.key(KEY.ctrlD);
});

test("@file mentions: popup lists matches, Tab inserts, the file's content is attached for the model", async () => {
  const t = rig([say("read it")], { files: { "README.md": "# Demo\nsecret-token-123\n", "src/main.ts": "export {}\n" } }); await t.start();
  await t.type("explain @rea");
  assert.ok(await t.until(() => /README\.md/.test(plain(t.screen()))));
  await t.key(KEY.tab); assert.match(t.screen(), /^❯ explain @README\.md\s*$/m);
  await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle()));
  assert.match(plain(t.text()), /attached README\.md \(2 lines\)/);
  const sent = t.seen[0].msgs.at(-1)!.content!;
  assert.match(sent, /explain @README\.md/); assert.match(sent, /<file path="README\.md">\n# Demo\nsecret-token-123/);
  await t.key(KEY.ctrlD);
});

test("multi-line input: backslash+Enter, Alt+Enter and bracketed paste (large pastes collapse to a placeholder and expand on send)", async () => {
  const t = rig([say("got it")]); await t.start();
  await t.type("line one\\"); await t.key(KEY.enter); await t.type("line two"); await t.key(KEY.altEnter); await t.type("line three");
  const s = plain(t.screen());
  assert.match(s, /❯ line one\n\s+line two\n\s+line three/);
  const big = Array.from({ length: 15 }, (_, i) => `pasted ${i}`).join("\n");
  await t.type(`\x1b[200~${big}\x1b[201~`);
  assert.match(plain(t.screen()), /\[Pasted text #1 \+15 lines\]/);
  await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle()));
  const sent = t.seen[0].msgs.at(-1)!.content!;
  assert.equal(sent, `line one\nline two\nline three${big}`);
  await t.key(KEY.ctrlD);
});

test("steering: a message typed while a tool runs is queued, shown, and delivered at the next step", async () => {
  const t = rig([call("sh", { cmd: "sleep 0.5" }, "starting"), say("adjusted")]); await t.start();
  t.app.setMode("yolo");
  await t.submit("long job");
  assert.ok(await t.until(() => t.seen.length >= 1 && t.app.inflight.size > 0));
  await t.submit("also mention the weather");
  assert.match(plain(t.screen()), /queued: also mention the weather/); assert.match(plain(t.screen()), /1 queued/);
  assert.ok(await t.until(() => t.idle() && t.has("adjusted"), 4000));
  assert.match(plain(t.text()), /❯ also mention the weather\n\s+sent while working/);
  const second = t.seen[1].msgs;                                                              // delivered into the SAME turn, right after the tool result
  assert.deepEqual(second.slice(-2).map((m) => m.role), ["tool", "user"]); assert.equal(second.at(-1)!.content, "also mention the weather");
  assert.equal(t.seen.length, 2);                                                             // no extra turn was needed
  await t.key(KEY.ctrlD);
});

test("a message queued at the very end starts its own turn automatically", async () => {
  const g = gate();
  const t = rig([async () => { await g.p; return say("first answer"); }, say("second answer")]); await t.start();
  await t.submit("one"); await t.submit("two");
  g.open();
  assert.ok(await t.until(() => t.has("second answer") && t.idle()));
  assert.equal(t.seen.length, 2); assert.equal(t.seen[1].msgs.at(-1)!.content, "two");
  await t.key(KEY.ctrlD);
});

test("Esc interrupts a running turn at a safe point and the app stays usable", async () => {
  const g = gate();
  const t = rig([call("sh", { cmd: "ls" }), async (_m, _t, o) => { await Promise.race([g.p, new Promise((_, rej) => o.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))))]); return say("never"); }, say("after interrupt")]); await t.start();
  await t.submit("work");
  assert.ok(await t.until(() => t.seen.length >= 2));
  await t.key(KEY.esc, 120);
  assert.ok(await t.until(() => t.idle() && t.has("interrupted")));
  assert.ok(!t.has("never"));
  await t.submit("continue please");
  assert.ok(await t.until(() => t.has("after interrupt") && t.idle()));
  await t.key(KEY.ctrlD);
});

test("Ctrl-C: clears input first, then needs a second press to exit", async () => {
  const t = rig([]); await t.start();
  await t.type("draft"); await t.key(KEY.ctrlC); assert.ok(!/❯ draft/.test(t.screen()));
  await t.key(KEY.ctrlC); assert.match(t.screen(), /press ctrl-c again to exit/);
  await t.key(KEY.ctrlC); assert.equal(await t.app.done, 0);
});

test("/undo reverts the turn's file changes and drops it from the conversation; /clear starts fresh", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), call("write_file", { path: "a.txt", content: "CHANGED\n" }), call("write_file", { path: "new.txt", content: "n\n" }), say("done")]); await t.start();
  await t.key(KEY.backtab); await t.submit("rewrite");
  assert.ok(await t.until(() => t.idle()));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "CHANGED\n"); assert.ok(existsSync(join(t.dir, "new.txt")));
  await t.submit("/undo");
  assert.ok(await t.until(() => t.has("rewound")));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "one\ntwo\n"); assert.ok(!existsSync(join(t.dir, "new.txt")));
  assert.equal(t.app.session.messages.length, 0); assert.equal(t.app.session.turns.length, 0);
  await t.submit("/clear"); assert.match(t.screen(), /conversation cleared/);
  await t.key(KEY.ctrlD);
});

test("Ctrl+O opens a scrollable full transcript in the alternate screen and closes cleanly", async () => {
  const t = rig([call("sh", { cmd: "echo hi" }), say("all done")]); await t.start();
  await t.key(KEY.backtab); await t.submit("do it"); await t.key("1");
  assert.ok(await t.until(() => t.idle()));
  await t.key(KEY.ctrlO);
  assert.equal(t.vt.altActive, true); assert.match(t.screen(), /transcript · /); assert.match(plain(t.screen()), /do it/); assert.match(plain(t.screen()), /all done/);
  await t.key("q");
  assert.equal(t.vt.altActive, false);
  await t.key(KEY.ctrlD);
});

test("/tokens (alias /cost) shows the context gauge, what fills it, usage and cost; the footer carries a live gauge", async () => {
  const t = rig([call("read_file", { path: "a.txt" }), say("hi")]); await t.start();
  await t.submit("hello"); assert.ok(await t.until(() => t.idle()));
  await t.submit("/tokens"); assert.ok(await t.until(() => t.has("est. cost"), 6000));         // wait for the output itself, not for a fixed delay
  const out = plain(t.text());
  assert.match(out, /Tokens\n[\s\S]*context window\s+▰*▱+ 0%/); assert.match(out, /what fills it\s+█+/); assert.match(out, /■ system \d+%\s+■ tool defs \d+%/);                           // in a fresh chat the tool definitions are the big slice; tiny parts drop out of the legend
  assert.match(out, /this chat\s+200 in · 40 out · 2 requests/); assert.match(out, /est\. cost\s+unknown for this model/);
  assert.match(plain(t.screen()), /▱+ 0%/);
  await t.submit("/cost"); assert.ok(await t.until(() => plain(t.text()).split("context window").length >= 3, 6000));   // the alias works
  await t.submit("/status"); assert.ok(await t.until(() => /session\s+\d{8}/.test(plain(t.text())), 6000));
  await t.key(KEY.ctrlD);
});

test("welcome card carries the logo and mascot; the terminal title tracks state", async () => {
  const t = rig([say("ok")]); const raw: string[] = []; const w = (t.app.io.output as any).write.bind(t.app.io.output); (t.app.io.output as any).write = (s: string) => (raw.push(s), w(s));
  await t.start();
  assert.match(plain(t.screen()), /▗▄▄▄▄▄▖\s+▄▀█ █▀▄▀█ █▄ █ █▀▀ █▀ █▀/); assert.match(plain(t.screen()), /◖ ◗/); assert.match(plain(t.screen()), /tip /);
  assert.ok(raw.join("").includes("\x1b]0;Amness · "));
  await t.submit("go"); assert.ok(await t.until(() => t.idle()));
  const titles = [...raw.join("").matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map((m) => m[1]);
  assert.ok(titles.some((x) => x.startsWith("● working")) && titles.at(-1)!.startsWith("✔ Amness"), JSON.stringify(titles));
  await t.key(KEY.ctrlD);
});

test("Ctrl+P opens a filterable command palette; picking a no-arg command runs it, an arg command pre-fills the input", async () => {
  const t = rig([]); await t.start();
  await t.key("\x10");
  assert.match(plain(t.screen()), /Commands/); assert.match(plain(t.screen()), /\/help\s+keys and commands/);
  await t.type("verif"); assert.match(plain(t.screen()), /\/verify\s+command that must pass/); assert.ok(!/\/help\s+keys and commands/.test(plain(t.screen())));      // filtered
  await t.key(KEY.enter); assert.match(t.screen(), /^❯ \/verify\s*$/m);                    // needs an argument: typed into the box for you
  await t.key("\x15"); await t.key("\x10"); await t.type("status"); await t.key(KEY.enter);
  assert.ok(await t.until(() => t.has("session")));
  await t.key(KEY.esc); await t.key("\x10"); await t.key(KEY.esc); assert.ok(!/Commands/.test(plain(t.screen())));      // esc closes it
  await t.key(KEY.ctrlD);
});

test("Alt+M opens the model picker directly", async () => {
  const t = rig([]); await t.start();
  await t.key("\x1bm"); assert.ok(await t.until(() => /Model/.test(plain(t.screen()))));
  assert.match(plain(t.screen()), /test-model/); await t.key(KEY.esc);
  await t.key(KEY.ctrlD);
});

test("status line animates while working (spinner glyph + elapsed + tokens), and warns about a full context window", async () => {
  const g = gate();
  const t = rig([async () => { await g.p; return say("done"); }]); await t.start();
  t.app.lastPrompt = 900_000; t.app.cfg.model = "claude-opus-5-5"; t.app.render();
  assert.match(plain(t.screen()), /context almost full · \/compact/); assert.match(plain(t.screen()), /▰+▱* 90%/);
  await t.submit("go");
  assert.ok(await t.until(() => /Working… \(\d+s · ↓ \d+ tokens/.test(plain(t.screen()))));
  const glyphs = new Set<string>();
  for (let i = 0; i < 12; i++) { const m = plain(t.screen()).match(/^(\S) Working/m); if (m) glyphs.add(m[1]); await sleep(110); }
  assert.ok(glyphs.size >= 3, `spinner glyph should change, saw ${[...glyphs].join("")}`);
  g.open(); assert.ok(await t.until(() => t.idle()));
  await t.key(KEY.ctrlD);
});

test("resuming a saved conversation replays the tail and continues with full history", async () => {
  const a = rig([say("first reply")]); a.app.persist = true; await a.start();
  await a.submit("remember the word pineapple"); assert.ok(await a.until(() => a.idle()));
  a.app.saveSession(); const store = a.app.store, id = a.app.session.id;
  await a.key(KEY.ctrlD);
  const b = rig([say("second reply")], { resume: id }); (b.app as any).store = store; b.app.cwd = a.app.cwd; (b.app as any).opts.resume = id; await b.start();
  assert.match(plain(b.text()), /earlier in this conversation/); assert.match(plain(b.text()), /remember the word pineapple/); assert.match(plain(b.text()), /first reply/);
  await b.submit("what was the word?"); assert.ok(await b.until(() => b.idle()));
  assert.ok(b.seen[0].msgs.some((m) => m.content === "remember the word pineapple"));
  await b.key(KEY.ctrlD);
});

test("errors from the model are shown, the conversation stays consistent, and the next message works", async () => {
  const t = rig([async () => { throw new Error("HTTP 401: invalid api key"); }, say("recovered")]); await t.start();
  await t.submit("hi"); assert.ok(await t.until(() => t.idle() && t.has("HTTP 401")));
  assert.match(plain(t.text()), /check your key with \/provider/); assert.equal(t.app.session.turns.length, 0);
  await t.submit("again"); assert.ok(await t.until(() => t.has("recovered") && t.idle()));
  await t.key(KEY.ctrlD);
});

test("# saves a memory note; ! runs a shell command now and feeds its output to the next turn", async () => {
  const t = rig([say("noted")]); await t.start();
  await t.submit("# always use pnpm in this repo");
  assert.match(plain(t.text()), /remembered: always use pnpm in this repo/); assert.equal(t.app.memory!.list().some((e) => /pnpm/.test(e.content)), true);
  await t.submit("!echo from-shell"); assert.ok(await t.until(() => t.has("from-shell")));
  await t.submit("what did the shell print?"); assert.ok(await t.until(() => t.idle()));
  assert.match(t.seen[0].msgs.at(-1)!.content!, /I ran `echo from-shell`[\s\S]*from-shell[\s\S]*what did the shell print\?/);
  await t.key(KEY.ctrlD);
});

test("custom slash commands from .amness/commands/*.md: listed in the popup, $ARGUMENTS substituted, project overrides user", async () => {
  const t = rig([say("audited")], { files: { ".amness/commands/audit.md": "---\ndescription: Audit the current diff\n---\nReview the working-tree changes. Focus on: $ARGUMENTS\nBe brief.\n", ".amness/commands/ship.md": "# Ship it\nRun the tests and summarise.\n" } }); await t.start();
  await t.type("/aud"); assert.match(plain(t.screen()), /\/audit\s+Audit the current diff \(project\)/);
  await t.key("\x15"); await t.type("/sh"); assert.match(plain(t.screen()), /\/ship\s+Ship it \(project\)/);
  await t.key("\x15"); await t.type("/audit security and secrets"); await t.key(KEY.enter); await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle() && t.has("audited")));
  assert.equal(t.seen[0].msgs.at(-1)!.content, "Review the working-tree changes. Focus on: security and secrets\nBe brief.");
  await t.key(KEY.ctrlD);
});

test("/mcp attaches a server live: its tools are callable, read-only ones run, destructive ones ask first", async () => {
  const t = rig([call("fake_mcp__echo", { text: "yo" }), call("fake_mcp__wipe", {}), say("done")]); await t.start();
  t.app.cwd = process.cwd();
  try {
  await t.submit("/mcp node test/fake-mcp.mjs");
  assert.ok(await t.until(() => t.has("2 tools"), 8000)); assert.match(plain(t.text()), /fake_mcp__echo/);
  await t.submit("use the tools");
  assert.ok(await t.until(() => t.has("may change external state"), 5000));                  // the destructive tool is gated
  await t.key("3"); await t.type("not that one"); await t.key(KEY.enter);
  assert.ok(await t.until(() => t.idle(), 5000));
  assert.match(plain(t.text()), /● fake_mcp__echo\(yo\)/); assert.ok(t.seen.at(-1)!.msgs.some((m) => (m.content ?? "").includes("\necho:yo\n")));
  assert.match(t.seen.at(-1)!.msgs.filter((m) => m.role === "tool").at(-1)!.content!, /DENIED: not that one/);
  await t.submit("/mcp off"); assert.match(plain(t.text()), /MCP servers detached/);
  } finally { t.app.exit(0); }                                                                 // never leave the MCP child process behind
});

test("generic tool prompts offer 'don't ask again for <tool>' for the rest of the session", async () => {
  const t = rig([call("fake_mcp__wipe", {}), call("fake_mcp__wipe", { again: 1 }), say("done")]); await t.start();
  t.app.cwd = process.cwd();
  try {
    await t.submit("/mcp node test/fake-mcp.mjs"); assert.ok(await t.until(() => t.has("2 tools"), 8000));
    await t.submit("wipe twice");
    assert.ok(await t.until(() => t.has("Allow this?"), 5000)); assert.match(plain(t.screen()), /don't ask again for fake_mcp__wipe/);
    await t.key("2");
    assert.ok(await t.until(() => t.idle(), 5000));
    assert.ok(t.app.toolRules.has("fake_mcp__wipe")); assert.equal(plain(t.text()).split("Allow this?").length - 1, 0);   // the second call did not stop for a prompt
  } finally { t.app.exit(0); }
});

test("/effort lists only the levels the current model accepts; /model offers the current OpenAI lineup; /api switches the wire API", async () => {
  const t = rig([]); await t.start();
  t.app.cfg.provider = "openai"; t.app.cfg.model = "gpt-6.1-sol"; t.app.buildAgent();
  await t.submit("/effort");
  const s = plain(t.screen());
  assert.match(s, /Reasoning effort/); assert.match(s, /low/); assert.match(s, /max/); assert.ok(!/\bnone\b/.test(s) && !/minimal/.test(s), "Sol does not accept none/minimal");
  await t.key("\x1b[B"); await t.key("\x1b[B"); await t.key(KEY.enter);                       // default → low → medium
  assert.equal(t.app.cfg.effort, "medium");
  await t.submit("/effort none"); assert.match(plain(t.text()), /"none" is not valid for gpt-6\.1-sol/); assert.equal(t.app.cfg.effort, "medium");
  t.app.cfg.model = "gpt-6-luna"; await t.submit("/effort none"); assert.equal(t.app.cfg.effort, "none");      // Luna does accept it
  t.app.cfg.model = "gpt-4.1"; await t.submit("/effort high"); assert.match(plain(t.text()), /gpt-4\.1 is not a reasoning model/);
  await t.submit("/model"); const m = plain(t.screen());
  assert.match(m, /gpt-6\.1-sol/); assert.match(m, /gpt-6-astra/); assert.match(m, /gpt-6\.1-terra/); assert.match(m, /gpt-6-luna/);
  await t.key(KEY.esc);
  await t.submit("/api responses"); assert.equal(t.app.cfg.api, "responses"); assert.match(plain(t.text()), /api → responses/);
  await t.submit("/api nonsense"); assert.match(plain(t.text()), /unknown mode "nonsense"/);
  await t.key(KEY.ctrlD);
});

test("switching to a model that rejects the saved effort clears it instead of sending a 400", async () => {
  const t = rig([]); await t.start();
  t.app.cfg.provider = "openai"; t.app.cfg.model = "gpt-6-luna"; t.app.cfg.effort = "none";
  await t.submit("/model gpt-6-astra");
  assert.equal(t.app.cfg.effort, undefined); assert.match(plain(t.text()), /effort "none" is not valid for gpt-6-astra/);
  await t.key(KEY.ctrlD);
});

test("reasoning summaries stream into the status area live and disappear when the answer starts; cache hits and reasoning tokens reach /tokens", async () => {
  const g = gate();
  const resp = (): any => ({ role: "assistant", content: "Here you go.", usage: { prompt_tokens: 2000, completion_tokens: 500, total_tokens: 2500, cached_tokens: 1500, reasoning_tokens: 300 } });
  const t = rig([async (_m, _t, o) => { (o as any).onThinking?.("Weighing two approaches: "); (o as any).onThinking?.("a loop versus a slice."); await g.p; o.onText?.("Here you go."); return resp(); }]); await t.start();
  t.app.cfg.model = "gpt-6.1-sol"; t.app.cfg.provider = "openai";
  await t.submit("pick one");
  assert.ok(await t.until(() => /✻ Weighing two approaches: a loop versus a slice\./.test(plain(t.screen()))));
  g.open(); assert.ok(await t.until(() => t.idle()));
  assert.ok(!/Weighing two approaches/.test(plain(t.screen())));
  await t.submit("/tokens");
  const out = plain(t.text());
  assert.match(out, /prompt cache\s+75% of input served from cache/); assert.match(out, /reasoning\s+300 hidden reasoning tokens \(60% of output\)/);
  assert.match(out, /est\. cost\s+<\$0\.01\s+at \$2\/\$10 per M tokens, cached input at 10%/);
  await t.key(KEY.ctrlD);
});

test("/branch N forks the conversation after turn N, restores the files to that point and keeps the original's history out of the fork", async () => {
  const t = rig([say("first"), call("read_file", { path: "a.txt" }), call("write_file", { path: "a.txt", content: "SECOND\n" }), say("second")]); await t.start();
  await t.key(KEY.backtab); await t.submit("one"); assert.ok(await t.until(() => t.idle()));
  await t.submit("two"); assert.ok(await t.until(() => t.idle() && t.app.session.turns.length === 2));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "SECOND\n");
  const parentId = t.app.session.id, parentMsgs = t.app.session.messages.length;
  await t.submit("/branch 1"); assert.ok(await t.until(() => t.has("branched after turn 1")));
  assert.equal(readFileSync(join(t.dir, "a.txt"), "utf8"), "one\ntwo\n");
  assert.equal(t.app.session.turns.length, 1); assert.notEqual(t.app.session.id, parentId); assert.equal(t.app.session.parent?.id, parentId); assert.ok(t.app.session.messages.length < parentMsgs);
  await t.key(KEY.ctrlD);
});

test("/budget shows and sets the cap; /lsp and /approver toggle their options", async () => {
  const t = rig([]); await t.start();
  await t.submit("/budget"); assert.ok(await t.until(() => t.has("cap per turn: 100,000 tokens")));
  await t.submit("/budget 450k"); assert.ok(await t.until(() => t.has("now 450,000 tokens"))); assert.equal(t.app.budget.maxTokens, 450000); assert.equal(t.app.cfg.maxTokens, 450000);
  await t.submit("/budget 5"); assert.ok(await t.until(() => t.has("at least 10000")));
  await t.submit("/lsp on"); assert.ok(await t.until(() => t.has("diagnostics on"))); assert.equal(t.app.cfg.lsp, true);
  await t.submit("/approver on"); assert.ok(await t.until(() => t.has("approval reviewer on"))); assert.equal(t.app.cfg.approvalReviewer, true);
  await t.submit("/approver off"); assert.ok(await t.until(() => t.has("approval reviewer off"))); assert.equal(t.app.cfg.approvalReviewer, false);
  await t.key(KEY.ctrlD);
});

test("full-screen sidebar shows the turn's budget use once a turn has spent tokens", async () => {
  const t = rig([call("list_files", {}), say("done")], { ui: "full", cols: 132, rows: 40, cfg: { maxTokens: 1000 } }); await t.start();
  await t.submit("look"); assert.ok(await t.until(() => t.idle()));
  assert.ok(await t.until(() => /budget \d+% of/.test(plain(t.screen()))), plain(t.screen()).slice(0, 1500));
  await t.key(KEY.ctrlD);
});

test("interrupting while an Explore subagent runs leaves no card spinning, and a wrong agent name still gets an answer", async () => {
  const hang = async (_m: any, _t: any, o: any) => { await new Promise((_, rej) => o.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))); return say("never"); };
  const t = rig([call("task", { description: "survey the repo", agent: "explorer" }), hang]); await t.start();
  await t.submit("explore it"); assert.ok(await t.until(() => t.seen.length >= 2));
  assert.ok(t.app.blocks.blocks.some((b: any) => b.kind === "tool" && b.status === "running"));
  await t.key(KEY.esc, 120); assert.ok(await t.until(() => t.idle()));
  assert.equal(t.app.blocks.blocks.filter((b: any) => b.kind === "tool" && b.status === "running").length, 0);
  const task = t.app.blocks.blocks.find((b: any) => b.kind === "tool" && b.name === "task") as any; assert.equal(task.status, "fail");
  await t.key(KEY.ctrlD);
});

test("a subagent's steps are drawn inside its own card (not scattered), summarised when done, and listed when opened", async () => {
  const t = rig([call("task", { description: "survey" }), call("read_file", { path: "a.txt" }), call("grep", { pattern: "one" }), call("finish", { summary: "a.txt holds one" }), say("It holds one.")], { ui: "full", cols: 132, rows: 40 }); await t.start();
  await t.submit("explore"); assert.ok(await t.until(() => t.idle()));
  const top = t.app.blocks.blocks.filter((b: any) => b.kind === "tool" && !b.parent).map((b: any) => b.name); assert.deepEqual(top, ["task"]);
  assert.equal(t.app.blocks.kids((t.app.blocks.blocks.find((b: any) => b.name === "task") as any).callId).length, 2);
  let s = plain(t.screen()); assert.match(s, /2 steps · 1 file read · 1 search/);
  const task = t.app.blocks.blocks.find((b: any) => b.name === "task") as any; t.app.blocks.toggle(task.id); t.app.render(); await t.settle(200);
  s = plain(t.screen()); assert.match(s, /✓ Read\s+a\.txt/); assert.match(s, /✓ \w+\s+.*one/);
  await t.key(KEY.ctrlD);
});
