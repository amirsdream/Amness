import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager, createCodeAgent, type Message, type Model } from "../src/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "amness-pr-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("procs: output arrives in increments, status is tracked, stop kills the whole process group", async () => {
  const m = new ProcessManager(dir());
  const p = m.start(`node -e "let i=0;const t=setInterval(()=>{console.log('tick '+(++i));if(i==3)clearInterval(t)},60);setTimeout(()=>{},60000)"`, "ticker");
  assert.equal(p.status, "running"); assert.equal(p.name, "ticker");
  const r1 = await m.read(p.id, { waitMs: 2000 }); assert.match(r1.output, /tick 1/);
  await sleep(300);
  const r2 = await m.read(p.id); assert.ok(!r2.output.includes("tick 1") && r2.output.includes("tick 3"));      // only what is new
  assert.equal((await m.read(p.id)).output, "");
  assert.equal(r2.status, "running");
  const stopped = await m.stop(p.id); assert.equal(stopped.status, "killed"); await sleep(100); assert.ok(!alive(p.pid!));
});

test("procs: a process that exits reports its code; stderr is captured; waiting returns early on exit", async () => {
  const m = new ProcessManager(dir()), p = m.start(`echo out; echo err >&2; exit 3`);
  const t0 = Date.now(); const r = await m.read(p.id, { waitMs: 5000 }); await sleep(100); const r2 = await m.read(p.id, { waitMs: 5000 });
  assert.ok(Date.now() - t0 < 3000); assert.match(r.output + r2.output, /out/); assert.match(r.output + r2.output, /err/);
  assert.deepEqual([r2.status, r2.code], ["exited", 3]);
});

test("procs: output is bounded, the limit on concurrent processes holds, unknown ids explain themselves, dispose kills everything", async () => {
  const m = new ProcessManager(dir(), { max: 2 });
  const big = m.start(`node -e "for(let i=0;i<30000;i++)console.log('line '+i+' '+'x'.repeat(20))"`);
  for (let i = 0; i < 40 && m.list().find((p) => p.id === big.id)?.status === "running"; i++) await sleep(250); const r = await m.read(big.id, { maxChars: 500 }); assert.ok(r.output.length <= 500 && r.skipped > 100_000 && /line 29999/.test(r.output));
  const a = m.start("sleep 30"), b = m.start("sleep 30"); assert.throws(() => m.start("sleep 30"), /already running 2/);
  await assert.rejects(m.read("nope"), /no background process "nope"/);
  await m.dispose(); await sleep(100); assert.ok(!alive(a.pid!) && !alive(b.pid!)); assert.deepEqual(m.list().filter((p) => p.status === "running"), []);
});

test("agent: the model can start a server, read its output, and stop it through the tools; plan mode hides sh_start", async () => {
  const d = dir(); let n = 0;
  const call = (name: string, args: object): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "b" + ++n, function: { name, arguments: JSON.stringify(args) } }] });
  const q = [call("sh_start", { cmd: `node -e "console.log('listening on 3000');setTimeout(()=>{},60000)"`, name: "server" }), call("sh_read", { id: "p1", wait_ms: 3000 }), call("sh_list", {}), call("sh_stop", { id: "p1" }), { role: "assistant", content: "done" } as Message];
  const seenSpecs: string[][] = [];
  const model: Model = async (_m, specs) => { seenSpecs.push(specs.map((s) => s.name)); return q.shift()!; };
  let mode: "yolo" | "plan" = "yolo";
  const agent = createCodeAgent({ model, cwd: d, memory: false, guidance: false, chat: true, permissions: { mode: () => mode } });
  const r = await agent.chat([], "start the dev server");
  const tools = r.messages.filter((m) => m.role === "tool").map((m) => m.content!);
  assert.match(tools[0], /started p1 \(server\) running/); assert.match(tools[1], /listening on 3000/); assert.match(tools[2], /p1 \(server\) running/); assert.match(tools[3], /stopped p1 \(server\) killed/);
  assert.ok(seenSpecs[0].includes("sh_start") && seenSpecs[0].includes("sh_read"));
  mode = "plan"; const p2: string[][] = []; await createCodeAgent({ model: async (_m, s) => (p2.push(s.map((x) => x.name)), { role: "assistant", content: "ok" }), cwd: d, memory: false, guidance: false, chat: true, permissions: { mode: () => mode } }).chat([], "hi");
  assert.ok(!p2[0].includes("sh_start") && p2[0].includes("sh_read"));
  await agent.procs!.dispose();
});
