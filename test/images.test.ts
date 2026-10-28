import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readImage, visionLikely, toAnthropic, openai } from "../src/index.ts";
import { expandMentions } from "../cli/tui/mentions.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const dir = () => { const d = mkdtempSync(join(tmpdir(), "amness-img-")); writeFileSync(join(d, "shot.png"), PNG); writeFileSync(join(d, "big.png"), Buffer.alloc(6 * 1024 * 1024)); writeFileSync(join(d, "a.txt"), "hello"); return d; };

test("readImage encodes small images and refuses oversized or unsupported files", () => {
  const d = dir(), i = readImage(join(d, "shot.png")); assert.equal(i.mime, "image/png"); assert.equal(Buffer.from(i.data, "base64").length, PNG.length);
  assert.throws(() => readImage(join(d, "big.png")), /over the 5 MB limit/); assert.throws(() => readImage(join(d, "a.txt")), /not a supported image/);
});

test("@shot.png attaches an image instead of dumping bytes as text; problems are reported", () => {
  const d = dir(), r = expandMentions("what is wrong in @shot.png and @big.png and @a.txt?", d);
  assert.equal(r.images.length, 1); assert.ok(r.attached.some((a) => a.image)); assert.ok(r.problems.some((p) => /big\.png/.test(p))); assert.match(r.text, /<file path="a\.txt">/); assert.doesNotMatch(r.text, /PNG/);
});

test("Claude gets image blocks before the text; OpenAI Responses and Chat get data URLs", async () => {
  const img = { mime: "image/png", data: "QUJD" };
  const a = toAnthropic([{ role: "user", content: "look", images: [img] }]); assert.deepEqual(a.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }); assert.equal(a.messages[0].content[1].text, "look");
  const bodies: any[] = []; const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(bodies.length === 1 ? { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: {} } : { choices: [{ message: { role: "assistant", content: "ok" } }], usage: {} }), { headers: { "content-type": "application/json" } }); }) as any;
  try {
    await openai({ apiKey: "k", baseUrl: "http://x/v1", model: "gpt-5", api: "responses" })([{ role: "user", content: "look", images: [img] }], []);
    await openai({ apiKey: "k", baseUrl: "http://x/v1", model: "gpt-4o", api: "chat" })([{ role: "user", content: "look", images: [img] }], []);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(bodies[0].input[0].content[1], { type: "input_image", image_url: "data:image/png;base64,QUJD" });
  assert.deepEqual(bodies[1].messages[0].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
});

test("visionLikely: hosted models yes, old text-only no, local models by name", () => {
  assert.ok(visionLikely("anthropic", "claude-sonnet-5-5")); assert.ok(visionLikely("openai", "gpt-5")); assert.ok(!visionLikely("openai", "gpt-3.5-turbo"));
  assert.ok(visionLikely("ollama", "llava:13b")); assert.ok(!visionLikely("ollama", "qwen2.5-coder:7b"));
});
