import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "../src/lsp.ts";

// A fake language server: replies to initialize/shutdown and publishes one error for any file containing "BAD".
const FAKE = `
let buf = Buffer.alloc(0);
const send = (m) => { const b = JSON.stringify({ jsonrpc: "2.0", ...m }); process.stdout.write("Content-Length: " + Buffer.byteLength(b) + "\\r\\n\\r\\n" + b); };
const check = (uri, text) => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: text.includes("BAD") ? [{ range: { start: { line: 1, character: 4 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.\\nmore", source: "fake" }, { range: { start: { line: 0, character: 0 } }, severity: 2, message: "just a warning" }] : [] } });
process.stdin.on("data", (d) => { buf = Buffer.concat([buf, d]);
  for (;;) { const h = buf.indexOf("\\r\\n\\r\\n"); if (h < 0) return; const len = +/Content-Length: (\\d+)/.exec(buf.slice(0, h).toString())[1]; if (buf.length < h + 4 + len) return;
    const m = JSON.parse(buf.slice(h + 4, h + 4 + len).toString()); buf = buf.slice(h + 4 + len);
    if (m.method === "initialize") send({ id: m.id, result: { capabilities: {} } });
    else if (m.method === "shutdown") send({ id: m.id, result: null });
    else if (m.method === "exit") process.exit(0);
    else if (m.method === "textDocument/didOpen") check(m.params.textDocument.uri, m.params.textDocument.text);
    else if (m.method === "textDocument/didChange") check(m.params.textDocument.uri, m.params.contentChanges[0].text); } });
`;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "amness-lsp-")); writeFileSync(join(dir, "fake.js"), FAKE);
  const servers = [{ name: "fake", command: "node", args: [join(dir, "fake.js")], extensions: [".ts"], languageId: () => "typescript" }];
  return { dir, d: new Diagnostics(dir, { servers }) };
}

test("reports only errors for the edited file, then goes quiet once it is fixed", async () => {
  const { dir, d } = setup();
  try {
    writeFileSync(join(dir, "a.ts"), "let x: number =\n    BAD;\n");
    const r = await d.report(["a.ts"]);
    assert.match(r, /a\.ts:2:5\s+Type 'string' is not assignable/); assert.doesNotMatch(r, /warning/); assert.doesNotMatch(r, /more/);
    writeFileSync(join(dir, "a.ts"), "let x: number = 1;\n");
    assert.equal(await d.report(["a.ts"]), "");
  } finally { await d.dispose(); }
});

test("files without a server, or with no installed server, add nothing", async () => {
  const { dir, d } = setup();
  try { writeFileSync(join(dir, "n.md"), "BAD"); assert.equal(await d.report(["n.md"]), ""); } finally { await d.dispose(); }
  const missing = new Diagnostics(dir, { servers: [{ name: "x", command: "no-such-lsp-binary", args: [], extensions: [".ts"], languageId: () => "typescript" }] });
  writeFileSync(join(dir, "b.ts"), "BAD"); assert.equal(await missing.report(["b.ts"]), "");
});
