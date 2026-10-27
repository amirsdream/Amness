import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, openaiEmbedder, utility, createCodeAgent, firstCacheBreak, prefixSignature, createHarness, defineTool, type Message, type Model } from "../src/index.ts";

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

// A toy embedder: words from the same group land on the same axis, so "automobile" and "car" are close without sharing a letter.
const GROUPS = [["car", "automobile", "vehicle"], ["database", "postgres", "sql"], ["deploy", "release", "ship"]];
const toy = (calls?: string[][]) => async (texts: string[]) => { calls?.push(texts); return texts.map((t) => { const v = GROUPS.map(() => 0); for (const w of t.toLowerCase().split(/\W+/)) GROUPS.forEach((g, i) => { if (g.includes(w)) v[i] += 1; }); return v; }); };

test("semantic memory: a note with no shared words is found through its embedding; vectors are cached on disk and only recomputed for changed notes", async () => {
  const m = store(), calls: string[][] = []; m.embedder = toy(calls);
  m.save(note("rides", "how we travel", "Pick any automobile from the lot")); m.save(note("storage", "persistence", "Use postgres for everything")); m.save(note("misc", "other", "nothing relevant here"));
  assert.equal(m.rank("car").length, 0);                                  // keyword search alone finds nothing
  await m.index(); await m.warmQuery("car");
  assert.equal(m.rank("car")[0].e.name, "rides");                         // meaning-level match
  assert.ok(m.rank("car").every((x) => x.e.name !== "misc"));
  const first = calls.flat().length; await m.index(); assert.equal(calls.flat().length, first);   // nothing new to embed
  m.save(note("misc", "other", "we deploy on fridays")); assert.equal(await m.index(), 1);        // only the changed note
  const fresh = store(); fresh.dirs = m.dirs; fresh.embedder = toy(); assert.equal(await fresh.index(), 0);   // reloaded from embeddings.json
  await fresh.warmQuery("ship it"); assert.equal(fresh.rank("ship it")[0].e.name, "misc");
});

test("semantic memory: a failing embedder falls back to keyword search silently", async () => {
  const m = store(); m.embedder = async () => { throw new Error("offline"); };
  m.save(note("tests", "how to run tests", "npm test"));
  await m.index().catch(() => {}); await m.warmQuery("run tests");
  assert.equal(m.rank("run tests")[0].e.name, "tests");
});

test("learning from outcomes: notes from good runs rise, notes from failed runs sink and become prune candidates; chat replies change nothing", () => {
  const m = store();
  m.save(note("helpful", "build tips", "build the project with make all")); m.save(note("misleading", "compile pointers", "invoke gcc manually over every source file listing"));
  const get = (n: string) => m.list().find((e) => e.name === n)!;
  assert.equal(utility(get("helpful")), 0.5);
  const both = () => m.touch(m.list());
  both(); m.endTurn(undefined); assert.equal(get("helpful").wins, 0);             // inconclusive: nothing learned
  for (let i = 0; i < 4; i++) { m.touch([get("helpful")]); m.endTurn(true); m.touch([get("misleading")]); m.endTurn(false); }
  assert.ok(utility(get("helpful")) > 0.8 && utility(get("misleading")) < 0.2);
  assert.equal(m.rank("build the project")[0].e.name, "helpful");
  assert.deepEqual(m.stale().map((e) => e.name), ["misleading"]);               // 4 failed runs, none good: suggested for archiving
});

test("openaiEmbedder posts to /embeddings in order and reports errors", async () => {
  const { createServer } = await import("node:http");
  const seen: any[] = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const body = JSON.parse(b); seen.push({ url: req.url, auth: req.headers.authorization, body });
    if (seen.length === 2) { res.statusCode = 401; return void res.end("bad key"); }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: [i, 1] })).reverse() }));   // out of order on purpose
  }); });
  await new Promise<void>((r) => srv.listen(0, r)); const base = `http://127.0.0.1:${(srv.address() as any).port}/v1`;
  const emb = openaiEmbedder({ baseUrl: base, apiKey: "k", model: "m" });
  assert.deepEqual(await emb(["a", "b"]), [[0, 1], [1, 1]]);
  assert.equal(seen[0].url, "/v1/embeddings"); assert.equal(seen[0].auth, "Bearer k"); assert.equal(seen[0].body.model, "m");
  await assert.rejects(emb(["x"]), /HTTP 401/);
  srv.closeAllConnections(); srv.close();
});

test("agent: a finished run credits the notes it saw; a stuck run counts against them; a plain reply changes nothing", async () => {
  const mk = (replies: Message[]) => { const dir = mkdtempSync(join(tmpdir(), "amness-learn-")), m = new MemoryStore({ project: join(dir, ".amness", "memory") }); m.save(note("test-command", "how to run tests", "Run npm test")); return { m, dir, model: (async () => replies.shift() ?? { role: "assistant", content: "ok" }) as Model }; };
  const call = (n: string, a: object): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "x" + Math.random(), function: { name: n, arguments: JSON.stringify(a) } }] });
  let s = mk([call("finish", { summary: "done" })]);
  await createCodeAgent({ model: s.model, cwd: s.dir, memory: s.m, chat: true }).chat([], "how to run the tests"); assert.equal(s.m.list()[0].wins, 1);
  s = mk([{ role: "assistant", content: "Use npm test." }]);
  await createCodeAgent({ model: s.model, cwd: s.dir, memory: s.m, chat: true }).chat([], "how to run the tests"); assert.deepEqual([s.m.list()[0].wins, s.m.list()[0].losses], [0, 0]);
  s = mk(Array.from({ length: 8 }, (_, i) => call("read_file", { path: "missing" + i })));
  await createCodeAgent({ model: s.model, cwd: s.dir, memory: s.m, chat: true, maxSteps: 12 }).chat([], "how to run the tests"); assert.equal(s.m.list()[0].losses, 1);
});
