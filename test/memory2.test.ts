import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, createCodeAgent, firstCacheBreak, prefixSignature, createHarness, defineTool, type Message, type Model } from "../src/index.ts";

const store = () => { const d = mkdtempSync(join(tmpdir(), "amness-mem-")); return new MemoryStore({ project: join(d, "p"), global: join(d, "g") }); };
const note = (name: string, description: string, content: string, type: any = "project") => ({ name, type, description, content });

test("memory: BM25 ranks by meaning-bearing terms, handles plurals, and learns from use", () => {
  const m = store();
  m.save(note("test-command", "how to run the tests", "Run npm test; the suite uses node --test and takes 20 seconds"));
  m.save(note("deploy", "deployment steps", "Deploy with make release after tagging"));
  m.save(note("style", "code style", "Use tabs for indentation and trailing commas"));
  assert.equal(m.rank("how do I run my tests")[0].e.name, "test-command");
  assert.equal(m.rank("deploying a release")[0].e.name, "deploy");        // "deploying" ~ "deploy"
  assert.equal(m.rank("quantum chromodynamics").length, 0);
  m.search("tests"); m.search("tests");
  assert.equal(m.list().find((e) => e.name === "test-command")!.hits, 2);
});

test("memory: a near-duplicate note updates the existing one (newer wording wins) instead of piling up", () => {
  const m = store();
  m.save(note("test-command", "run tests", "Run npm test to execute the whole suite"));
  const r = m.save(note("how-to-test", "run the tests", "Run npm test to execute the whole test suite quickly"));
  assert.equal(r.merged, "test-command"); assert.equal(m.list().length, 1);
  assert.match(m.list()[0].content, /quickly/);
  m.save(note("other", "unrelated", "The staging database is postgres 15"));
  assert.equal(m.list().length, 2);
  // different type is never merged
  m.save(note("user-pref", "run tests", "Run npm test to execute the whole suite", "user")); assert.equal(m.list().length, 3);
});

test("memory: stale notes are archived (reversibly), used ones stay", () => {
  const m = store();
  m.save(note("old-fact", "something old", "an old fact nobody needs")); m.save(note("kept", "used often", "a fact that keeps being useful"));
  m.search("useful"); m.search("useful");
  const f = join(m.dirs.project!, "old-fact.md"), past = new Date(Date.now() - 200 * 86_400_000);
  const txt = readFileSync(f, "utf8").replace(/updated: .*/, `updated: ${past.toISOString().slice(0, 10)}`); require_write(f, txt);
  assert.deepEqual(m.stale().map((e) => e.name), ["old-fact"]);
  assert.deepEqual(m.prune(), ["old-fact"]);
  assert.ok(existsSync(join(m.dirs.project!, "archive", "old-fact.md"))); assert.deepEqual(m.list().map((e) => e.name), ["kept"]);
});
import { writeFileSync as require_write } from "node:fs";

test("memory: context caps the index; delta only surfaces new, relevant notes", () => {
  const m = store();
  for (let i = 0; i < 40; i++) m.save(note(`filler-${i}`, `topic${i}x subject${i}y`, `fact${i}a detail${i}b thing${i}c`));
  m.save(note("db-migrations", "how to run database migrations", "Run npm run migrate before the tests; it needs DATABASE_URL"));
  const seen = new Set<string>(), ctx = m.context("run the database migrations", 6000, seen);
  assert.match(ctx, /\+\d+ more; find them with memory_search/); assert.match(ctx, /Most relevant:\n### db-migrations/);
  assert.ok(ctx.split("\n").filter((l) => l.startsWith("- ")).length <= 25 && seen.has("project/db-migrations"));
  assert.equal(m.delta("migrate the database again", seen), "");            // already shown
  m.save(note("lint-rule", "linting configuration", "Run eslint with the strict config before committing"));
  assert.match(m.delta("please fix the eslint linting errors", seen), /lint-rule/);
  assert.equal(m.delta("what is the weather", seen), "");
});

test("agent: first message carries the index and relevant notes; a later message only adds new relevant notes at its end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amness-cmem-")), m = new MemoryStore({ project: join(dir, ".amness", "memory") });
  m.save(note("test-command", "how to run tests", "Run npm test")); m.save(note("lint-rule", "linting", "Invoke eslint --strict before committing"));
  const seen: Message[][] = [];
  const model: Model = async (msgs) => { seen.push(msgs.map((x) => ({ ...x }))); return { role: "assistant", content: "ok" }; };
  const agent = createCodeAgent({ model, cwd: dir, memory: m, chat: true });
  const r1 = await agent.chat([], "how do I run the tests?");
  const first = r1.messages.find((x) => x.role === "user")!.content!;
  assert.match(first, /Most relevant:\n### test-command/);
  const r2 = await agent.chat(r1.messages, "now fix the eslint linting problems");
  const last = r2.messages.filter((x) => x.role === "user").at(-1)!.content!;
  assert.match(last, /Memory relevant to this message[\s\S]*lint-rule/); assert.ok(!/test-command/.test(last));
  assert.equal(r2.messages[1].content, first);                                 // the earlier message is byte-identical: the cached prefix is untouched
});

test("cache: prefix signature detects tool changes and rewritten history, but not appends", () => {
  const msgs: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: "a" }];
  const spec = (n: string) => ({ name: n, description: "", parameters: { type: "object" } as any });
  const a = prefixSignature(msgs, [spec("x")]);
  assert.equal(firstCacheBreak(a, prefixSignature([...msgs, { role: "tool", content: "r", tool_call_id: "1" }], [spec("x")])), undefined);    // pure append
  assert.equal(firstCacheBreak(a, prefixSignature(msgs, [spec("x"), spec("y")]))!.at, -1);
  const edited = [...msgs]; edited[1] = { role: "user", content: "changed" };
  assert.equal(firstCacheBreak(a, prefixSignature(edited, [spec("x")]))!.at, 1);
});

test("harness: history is only rewritten when over budget, in one cut, and a cachebreak event says so", async () => {
  const big = defineTool({ name: "big", description: "", schema: { type: "object" }, readOnly: true, run: (a: any) => "x".repeat(5000) + a.i });
  let n = 0; const ev: any[] = [];
  const model: Model = async () => (n++ < 16 ? { role: "assistant", content: null, tool_calls: [{ id: "t" + n, function: { name: "big", arguments: JSON.stringify({ i: n }) } }] } : { role: "assistant", content: null, tool_calls: [{ id: "f", function: { name: "finish", arguments: JSON.stringify({ summary: "." }) } }] });
  await createHarness({ model, tools: [big], contextBudget: 30_000, maxSteps: 40, onEvent: (e) => ev.push(e) }).run("x");
  const breaks = ev.filter((e) => e.kind === "cachebreak"), trims = ev.filter((e) => e.kind === "trim" && e.what === "stale tool output");
  assert.ok(trims.length >= 1 && trims.length <= 6, String(trims.length));          // a handful of cuts across 16 turns, not one per turn
  assert.ok(breaks.length >= 1 && breaks.every((b) => b.at >= 0), JSON.stringify(breaks));                  // every rewrite is reported, and the tool list never changed
});

test("memory graph: [[links]] and notes retrieved together become neighbours; related notes ride along in ranking", () => {
  const m = store();
  m.save(note("db-setup", "database setup", "Postgres 15 on port 5433; see [[migrations]] for schema changes"));
  m.save(note("migrations", "schema migrations", "Run npm run migrate. Needs the database from db-setup"));
  m.save(note("release", "release process", "Tag the commit and run make release"));
  const all = m.list(), db = all.find((e) => e.name === "db-setup")!;
  assert.deepEqual(m.neighbors(db, all).map((e) => e.name), ["migrations"]);
  assert.deepEqual(m.neighbors(all.find((e) => e.name === "migrations")!, all).map((e) => e.name), ["db-setup"]);   // links work both ways
  assert.deepEqual(m.neighbors(all.find((e) => e.name === "release")!, all), []);
  // a query that only matches db-setup also surfaces its neighbour, ranked lower
  const r = m.rank("postgres port").map((x) => x.e.name); assert.deepEqual(r.slice(0, 2), ["db-setup", "migrations"]);
  // co-retrieval links notes that were never linked explicitly
  const rel = m.list().filter((e) => e.name === "release" || e.name === "migrations");
  m.touch(rel); assert.deepEqual(m.neighbors(m.list().find((e) => e.name === "release")!).map((e) => e.name), []);   // once is a coincidence
  m.touch(rel); assert.deepEqual(m.neighbors(m.list().find((e) => e.name === "release")!).map((e) => e.name), ["migrations"]);   // twice is a pattern
});

test("memory consolidate: the model proposes, bogus names are ignored, apply merges and archives reversibly", async () => {
  const m = store();
  m.save(note("test-cmd", "run tests", "npm test")); m.save(note("test-cmd-2", "tests command", "use npm test, it takes 20s", "reference")); m.save(note("old-port", "dev server port", "3000")); m.save(note("keep", "unrelated", "stays put"));
  const plan = JSON.stringify({ merges: [{ keep: "test-cmd", from: ["test-cmd-2", "ghost"], description: "how to run tests", content: "npm test (about 20s)" }, { keep: "ghost", from: ["keep"], description: "x", content: "y" }], archive: ["old-port", "nonexistent"] });
  const model: Model = async () => ({ role: "assistant", content: plan });
  const p = await m.consolidate(model);
  assert.deepEqual(p, { merges: [{ keep: "test-cmd", from: ["test-cmd-2"], description: "how to run tests", content: "npm test (about 20s)" }], archive: ["old-port"] });
  assert.equal(m.list().length, 4);                                         // proposing changes nothing
  assert.deepEqual(m.applyPlan(p), { merged: 1, archived: 2 });
  assert.deepEqual(m.list().map((e) => e.name).sort(), ["keep", "test-cmd"]); assert.equal(m.list().find((e) => e.name === "test-cmd")!.content, "npm test (about 20s)");
  assert.ok(existsSync(join(m.dirs.project!, "archive", "old-port.md")) && existsSync(join(m.dirs.project!, "archive", "test-cmd-2.md")));
});

test("cache keep-alive: warm() re-sends the same tool list with a tiny output cap", async () => {
  const calls: { specs: string; max?: number }[] = [];
  const model: Model = async (msgs, specs, o) => { calls.push({ specs: JSON.stringify(specs), max: o?.maxTokens }); return { role: "assistant", content: null, tool_calls: msgs.length < 4 ? [{ id: "a" + msgs.length, function: { name: "t", arguments: "{}" } }] : [{ id: "f", function: { name: "finish", arguments: '{"summary":"."}' } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cached_tokens: 80 } }; };
  const h = createHarness({ model, tools: [defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => "ok" })] });
  const r = await h.run("x");
  const w = await h.warm(r.messages);
  assert.deepEqual(w, { prompt: 100, cached: 80 });
  const last = calls.at(-1)!, before = calls.at(-2)!;
  assert.equal(last.max, 16); assert.equal(last.specs, before.specs);       // identical tool definitions: the warm request hits the same cache entry
});
