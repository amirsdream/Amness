import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAgent, type Message, type Model, type OutsideRequest } from "../src/index.ts";

/** A project and a folder beside it, and an agent that makes the given file-tool calls. `outside` answers the access question; undefined leaves it out. */
async function run(calls: [string, object][], o: { outside?: (r: OutsideRequest) => boolean; mode?: "default" | "yolo" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "amness-out-")), proj = join(base, "proj"), lib = join(base, "lib");
  mkdirSync(proj); mkdirSync(lib); writeFileSync(join(proj, "a.ts"), "export const a = 1;\n"); writeFileSync(join(lib, "x.ts"), "export const x = 'lib x';\n"); writeFileSync(join(lib, "y.ts"), "export const y = 'lib y';\n");
  let n = 0; const fix = (v: unknown): unknown => typeof v === "string" ? v.replace("$LIB", lib) : Array.isArray(v) ? v.map(fix) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)])) : v;
  const q: Message[] = [...calls.map(([name, args]) => ({ role: "assistant", content: null, tool_calls: [{ id: "o" + ++n, function: { name, arguments: JSON.stringify(fix(args)) } }] }) as Message), { role: "assistant", content: "done" }];
  const seen: Message[][] = [], order: string[] = [], allowed: string[] = [];
  const model: Model = async (m) => { seen.push(m.map((x) => ({ ...x }))); return q.shift()!; };
  const agent = createCodeAgent({ model, cwd: proj, memory: false, guidance: false, chat: true, permissions: { mode: () => o.mode ?? "yolo" },
    approve: (r) => (order.push(`approve ${r.name}`), true), dirs: () => allowed,
    outside: o.outside && (async (r) => { order.push(`outside ${r.dir === lib ? "$LIB" : r.dir} ${r.write ? "write" : "read"}`); const ok = o.outside!(r); if (ok) allowed.push(r.dir); return ok; }) });
  await agent.chat([], "go");
  return { lib, order, outs: seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content!) };
}

test("outside the project: the user is asked once per folder; yes lets every file tool use it, reads and lists alike", async () => {
  const r = await run([["read_file", { path: "$LIB/x.ts" }], ["read_file", { path: "../lib/y.ts" }], ["list_files", { path: "$LIB" }], ["read_file", { path: "a.ts" }]], { outside: () => true });
  assert.deepEqual(r.order, ["outside $LIB read"]);                                  // one question covers the folder; the project's own file asks nothing
  assert.match(r.outs[0], /lib x/); assert.match(r.outs[1], /lib y/); assert.match(r.outs[2], /x\.ts[\s\S]*y\.ts/); assert.match(r.outs[3], /export const a/);
});

test("outside the project: no refuses the call with a clear reason, and the file is not read", async () => {
  const r = await run([["read_file", { path: "$LIB/x.ts" }]], { outside: () => false });
  assert.match(r.outs[0], /DENIED: the user did not allow access to .*lib, which is outside the project/); assert.doesNotMatch(r.outs[0], /lib x/);
});

test("outside the project: the access question comes before the edit approval, and an allowed folder can be edited", async () => {
  const r = await run([["read_file", { path: "$LIB/x.ts" }], ["edit_file", { path: "$LIB/x.ts", old: "lib x", new: "lib X" }]], { outside: () => true, mode: "default" });
  assert.deepEqual(r.order, ["outside $LIB read", "approve edit_file"]);           // the folder is allowed by then: only the usual edit prompt
  assert.equal(readFileSync(join(r.lib, "x.ts"), "utf8"), "export const x = 'lib X';\n");
  const w = await run([["write_file", { path: "$LIB/new.ts", content: "x" }]], { outside: () => true, mode: "default" });
  assert.deepEqual(w.order, ["outside $LIB write", "approve write_file"]);
});

test("outside the project: without an access question (a library user, amness run without --add-dir) outside paths are refused as before", async () => {
  const r = await run([["read_file", { path: "$LIB/x.ts" }]]);
  assert.match(r.outs[0], /path escapes the workspace/);
});
