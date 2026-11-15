import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, newSession, replay, type SessionData } from "../cli/tui/session.ts";

const project = () => mkdtempSync(join(tmpdir(), "amness-sess-"));
const turn = (text: string) => ({ at: 0, t: Date.now(), text, snaps: {} as Record<string, string | null> });
const say = (s: SessionData, user: string, reply: string) => { s.turns.push(turn(user)); s.messages.push({ role: "user", content: user }, { role: "assistant", content: reply }); };
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("sessions are append-only JSONL: the first save is a snapshot, later saves add only what changed", () => {
  const cwd = project(), st = new SessionStore(cwd), s = newSession(cwd, "m");
  say(s, "hello", "hi"); st.save(s);
  const f = join(cwd, ".amness", "chats", `${s.id}.jsonl`); assert.equal(lines(f).length, 1); assert.equal(lines(f)[0].k, "head");
  say(s, "and then", "done"); s.title = "a chat"; st.save(s);
  const after = lines(f); assert.deepEqual(after.slice(1).map((l) => l.k), ["msg", "msg", "turn", "meta"], "two messages, one turn and the new title");
  assert.deepEqual(new SessionStore(cwd).load(s.id), s, "replaying the lines gives the same conversation");
  const size = statSync(f).size; st.save(s); assert.equal(statSync(f).size, size, "a save that changed nothing writes nothing");
});

test("a rewind or a compaction is a cut, then the new messages; a crash that cuts the last line short loses only that save", () => {
  const cwd = project(), st = new SessionStore(cwd), s = newSession(cwd, "m");
  say(s, "one", "1"); say(s, "two", "2"); st.save(s);
  s.messages.length = 2; s.turns.length = 1; say(s, "two again", "2b"); st.save(s);
  const f = join(cwd, ".amness", "chats", `${s.id}.jsonl`);
  assert.ok(lines(f).some((l) => l.k === "cut" && l.messages === 2) && lines(f).some((l) => l.k === "cutTurns" && l.turns === 1));
  const back = new SessionStore(cwd).load(s.id)!; assert.deepEqual(back.messages.map((m) => m.content), ["one", "1", "two again", "2b"]);
  const good = readFileSync(f, "utf8"); appendFileSync(f, '{"k":"msg","m":{"role":"user","content":"half');      // the process died in the middle of a write
  assert.deepEqual(new SessionStore(cwd).load(s.id)!.messages.map((m) => m.content), ["one", "1", "two again", "2b"]);
  assert.equal(replay(good + "not json\n" + '{"k":"msg","m":{"role":"user","content":"after"}}\n')!.messages.length, 4, "nothing after a broken line is trusted");
});

test("when the appended lines outgrow the snapshot, the file is written again as one snapshot", () => {
  const cwd = project(), st = new SessionStore(cwd), s = newSession(cwd, "m"); say(s, "start", "ok"); st.save(s);
  const f = join(cwd, ".amness", "chats", `${s.id}.jsonl`), big = "x".repeat(40_000);
  for (let i = 0; i < 12; i++) { s.messages.length = 2; s.turns.length = 1; say(s, `retry ${i} ${big}`, "ok"); st.save(s); }
  assert.ok(lines(f).length < 12 * 3, `rewritten as a snapshot (${lines(f).length} lines)`);
  assert.equal(lines(f)[0].k, "head"); assert.deepEqual(new SessionStore(cwd).load(s.id), s);
});

test("an old .json conversation still loads and lists, and becomes .jsonl at its next save", () => {
  const cwd = project(), dir = join(cwd, ".amness", "chats"); mkdirSync(dir, { recursive: true });
  const old = newSession(cwd, "m"); say(old, "from before", "yes"); old.title = "old one"; writeFileSync(join(dir, `${old.id}.json`), JSON.stringify(old));
  const st = new SessionStore(cwd); assert.deepEqual(st.list().map((x) => x.title), ["old one"]);
  const s = st.load(old.id)!; assert.equal(s.messages[0].content, "from before");
  say(s, "new turn", "ok"); st.save(s);
  assert.ok(existsSync(join(dir, `${old.id}.jsonl`)) && !existsSync(join(dir, `${old.id}.json`)), "converted, and only one copy is left");
  assert.equal(new SessionStore(cwd).load(old.id)!.turns.length, 2);
});

test("the list comes from an index checked against the files: a chat another window changed, added or removed is seen", () => {
  const cwd = project(), a = new SessionStore(cwd), s1 = newSession(cwd, "m"); s1.title = "first"; say(s1, "x", "y"); a.save(s1);
  const s2 = { ...newSession(cwd, "m"), id: s1.id.slice(0, -4) + "zzzz" }; s2.title = "second"; say(s2, "x", "y"); a.save(s2);
  assert.deepEqual(a.list().map((x) => x.title).sort(), ["first", "second"]);
  assert.ok(existsSync(join(cwd, ".amness", "chats", "index.json")));
  const b = new SessionStore(cwd), other = b.load(s1.id)!; other.title = "renamed elsewhere"; b.save(other);
  assert.ok(a.list().some((x) => x.title === "renamed elsewhere"), "a change from another store shows");
  a.remove(s2.id); assert.deepEqual(a.list().map((x) => x.title), ["renamed elsewhere"]);
  assert.ok(!readdirSync(join(cwd, ".amness", "chats")).some((f) => f.endsWith(".tmp")), "no temporary files are left");
  const empty = newSession(cwd, "m"); a.save(empty); assert.equal(a.list().length, 1, "a conversation with no turns is not listed");
});
