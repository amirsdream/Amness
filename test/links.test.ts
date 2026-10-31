import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderBlock, type RenderCtx } from "../cli/tui/cards.ts";
import { trimUrl, urlsIn } from "../cli/tui/markdown.ts";
import { openUrl, openableUrl, openerFor } from "../cli/tui/openurl.ts";
import { getTheme } from "../cli/tui/themes.ts";
import type { Block } from "../cli/tui/blocks.ts";

test("only plain web links are ever opened", () => {
  for (const ok of ["https://example.com", "http://localhost:3000/a?b=1&c=2#x", "https://en.wikipedia.org/wiki/Foo_(bar)"]) assert.ok(openableUrl(ok), ok);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x.com/a", "data:text/html,hi", "vscode://open", "https://", "http:// evil.com", "https://a.com/\nrm -rf", "https://a.com/\x00", "//example.com", "example.com", ""]) assert.equal(openableUrl(bad), undefined, JSON.stringify(bad));
});

test("the address reaches the system opener as one argument, never through a shell", () => {
  const u = "https://a.com/x?y=1&z=2";
  assert.deepEqual(openerFor(u, "darwin"), { cmd: "open", args: [u] });
  assert.deepEqual(openerFor(u, "linux"), { cmd: "xdg-open", args: [u] });
  assert.deepEqual(openerFor(u, "win32"), { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", u] });   // `cmd /c start` would split at the &
});

const fakeChild = (how: "ok" | "fail" | "error" | "hang") => () => {
  const e = new EventEmitter() as EventEmitter & { unref(): void };
  e.unref = () => {};
  setImmediate(() => { if (how === "ok") e.emit("exit", 0); else if (how === "fail") e.emit("exit", 3); else if (how === "error") e.emit("error", new Error("ENOENT")); });
  return e as never;
};
test("openUrl: true when the opener works, false when it is missing or fails, and nothing is started for a bad address", async () => {
  const calls: string[][] = [];
  const spy = (how: "ok" | "fail" | "error") => (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return fakeChild(how)(); };
  assert.equal(await openUrl("https://a.com/", { platform: "linux", spawnFn: spy("ok") }), true);
  assert.deepEqual(calls[0], ["xdg-open", "https://a.com/"]);
  assert.equal(await openUrl("https://a.com/", { platform: "linux", spawnFn: spy("fail") }), false);      // e.g. xdg-open with no browser
  assert.equal(await openUrl("https://a.com/", { platform: "linux", spawnFn: spy("error") }), false);     // no opener installed (a server, a container)
  const n = calls.length;
  assert.equal(await openUrl("javascript:alert(1)", { spawnFn: spy("ok") }), false); assert.equal(calls.length, n, "nothing was started");
});

test("urlsIn: finds links in prose and takes off punctuation, emphasis and a stray closing bracket", () => {
  assert.equal(trimUrl("https://a.com/x."), "https://a.com/x"); assert.equal(trimUrl("https://a.com/x),"), "https://a.com/x");
  assert.equal(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)"), "https://en.wikipedia.org/wiki/Foo_(bar)");      // balanced brackets stay
  assert.equal(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar))."), "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.deepEqual(urlsIn("See [the docs](https://a.com/docs) and https://b.org/x?y=1, or **https://c.io/z**. Not a link: http://x"), ["https://a.com/docs", "https://b.org/x?y=1", "https://c.io/z"]);
  assert.deepEqual(urlsIn("no links here"), []);
});

const ctx = (width: number): RenderCtx => ({ theme: getTheme("dark"), width, now: 0, frame: 0, expandAll: false, live: false, brand: { icon: "◆", color: 0 }, diffMode: "auto" });
const assistant = (text: string): Block => ({ id: 7, kind: "assistant", text, streaming: false } as Block);
const slice = (r: ReturnType<typeof renderBlock>, h: { row: number; x0: number; x1: number }) => r.rows[h.row].map((c) => c.ch).join("").slice(h.x0, h.x1);

test("a link in a reply becomes a click target covering exactly the address, even when it is followed by text", () => {
  const r = renderBlock(assistant("Open https://example.com/start, then come back."), ctx(100));
  const links = r.hits.filter((h) => h.kind === "link");
  assert.equal(links.length, 1); assert.equal(links[0].text, "https://example.com/start");
  assert.equal(slice(r, links[0]), "https://example.com/start");
});

test("a markdown link and a bare link both work; a link in the middle of a line, and two on one line", () => {
  const r = renderBlock(assistant("Read [the guide](https://a.com/guide) or https://b.org/x?y=1 today."), ctx(100));
  const links = r.hits.filter((h) => h.kind === "link");
  assert.deepEqual(links.map((h) => h.text), ["https://a.com/guide", "https://b.org/x?y=1"]);
  assert.deepEqual(links.map((h) => slice(r, h)), ["https://a.com/guide", "https://b.org/x?y=1"]);
  assert.ok(links[0].x1 <= links[1].x0, "the two targets do not overlap");
});

test("a long link that was wrapped over several rows is one address with a target on each piece", () => {
  const url = "https://example.com/" + "segment/".repeat(12) + "end?x=1";
  const r = renderBlock(assistant(`Here: ${url} thanks`), ctx(48));
  const links = r.hits.filter((h) => h.kind === "link");
  assert.ok(links.length >= 2, `wrapped over ${links.length} rows`);
  assert.ok(links.every((h) => h.text === url), "every piece carries the full address");
  assert.equal(links.map((h) => slice(r, h)).join(""), url, "the pieces, joined, are the address");
  assert.equal(new Set(links.map((h) => h.row)).size, links.length, "one target per row");
});

test("the same link twice gives two targets; text without links gives none; links in code are not targets", () => {
  const twice = renderBlock(assistant("https://a.com/x and again https://a.com/x"), ctx(100)).hits.filter((h) => h.kind === "link");
  assert.equal(twice.length, 2); assert.ok(twice[0].x1 <= twice[1].x0);
  assert.equal(renderBlock(assistant("nothing to click"), ctx(100)).hits.filter((h) => h.kind === "link").length, 0);
});
