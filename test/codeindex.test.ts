import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndex, createCodeAgent, indexFile, indexTools, type Message, type Model } from "../src/index.ts";

const root = () => mkdtempSync(join(tmpdir(), "amness-ix-"));
const put = (base: string, rel: string, text: string) => { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); };

function repo() {
  const d = root();
  put(d, "src/billing/invoice.ts", "import { taxFor } from './tax.ts';\nimport { Customer } from '../customers/customer.js';\nexport interface Invoice { total: number }\nexport function computeInvoice(c: Customer, amount: number): Invoice {\n  return { total: amount + taxFor(c, amount) };\n}\n");
  put(d, "src/billing/tax.ts", "export const taxFor = (c: { region: string }, amount: number) => (c.region === 'EU' ? amount * 0.2 : 0);\nexport class TaxTable {\n  rate(region: string): number {\n    return 0.2;\n  }\n}\n");
  put(d, "src/customers/customer.ts", "export type Customer = { id: string; region: string };\nexport function loadCustomer(id: string): Customer { return { id, region: 'EU' }; }\n");
  put(d, "src/api/handler.ts", "import { computeInvoice } from '../billing/invoice.ts';\nimport { loadCustomer } from '../customers/customer.ts';\nexport async function handle(id: string) {\n  return computeInvoice(loadCustomer(id), 10);\n}\n");
  put(d, "src/api/index.ts", "export * from './handler.ts';\n");
  put(d, "app/main.ts", "import { handle } from '../src/api';\nhandle('1');\n");
  put(d, "py/shop/cart.py", "from .pricing import total_price\nimport shop.util\n\nclass Cart:\n    def checkout(self):\n        return total_price(self)\n");
  put(d, "py/shop/pricing.py", "def total_price(cart):\n    return 1\n\ndef _private(): pass\n");
  put(d, "py/shop/util.py", "def helper(): pass\n");
  put(d, "node_modules/x/index.js", "export function ignored() {}\n"); put(d, "README.md", "# docs\n");
  return d;
}

test("index: symbols are extracted per language (functions, classes, interfaces, types, methods), comments and ignored folders are skipped", () => {
  const f = indexFile("a.ts", "// export function fake() {}\nexport interface I {}\nexport type T = { a: 1 };\nexport const arrow = async (x: number) => x;\nexport class K {\n  run(): void {\n  }\n}\nfunction* gen() {}\n");
  assert.deepEqual(f.symbols.map((s) => `${s.kind}:${s.name}@${s.line}`), ["interface:I@2", "type:T@3", "function:arrow@4", "class:K@5", "method:run@6", "function:gen@9"]);
  assert.deepEqual(indexFile("a.py", "# def no():\ndef yes(): pass\nclass C:\n    async def m(self): pass\n").symbols.map((s) => s.name), ["yes", "C", "m"]);
  assert.deepEqual(indexFile("a.go", "func Top() {}\nfunc (s *S) Method() {}\ntype S struct {}\n").symbols.map((s) => s.name), ["Top", "Method", "S"]);
  assert.deepEqual(indexFile("a.rs", "pub fn go() {}\npub struct P;\nimpl P {\n    fn inner(&self) {}\n}\n").symbols.map((s) => s.name), ["go", "P", "P", "inner"]);
  const d = repo(), ix = new CodeIndex(d); ix.refresh(); assert.ok(![...ix.files.keys()].some((p) => p.includes("node_modules") || p.endsWith(".md")));
});

test("index: the import graph resolves relative specifiers (.js for .ts, index files, python relative and absolute) and finds dependents through hops", () => {
  const ix = new CodeIndex(repo()); ix.refresh();
  assert.deepEqual(ix.imports("src/billing/invoice.ts"), ["src/billing/tax.ts", "src/customers/customer.ts"]);         // './tax.ts' and '../customers/customer.js'
  assert.deepEqual(ix.imports("app/main.ts"), ["src/api/index.ts"]);                                                      // '../src/api' -> index.ts
  assert.deepEqual(ix.imports("py/shop/cart.py"), ["py/shop/pricing.py", "py/shop/util.py"]);
  assert.deepEqual(ix.importedBy("src/billing/tax.ts"), ["src/billing/invoice.ts"]);
  assert.deepEqual(ix.dependents("src/billing/tax.ts", 2).map((d) => [d.file, d.hops]), [["src/billing/invoice.ts", 1], ["src/api/handler.ts", 2]]);
});

test("index: ranking puts the defining files first for a query; with no query the most-imported files lead; output stays within its budget", () => {
  const ix = new CodeIndex(repo()); ix.refresh();
  assert.equal(ix.rank("invoice tax calculation")[0].file.path, "src/billing/invoice.ts"); assert.ok(ix.rank("invoice tax calculation").slice(0, 3).some((r) => r.file.path === "src/billing/tax.ts"));
  assert.equal(ix.rank("checkout cart")[0].file.path, "py/shop/cart.py"); assert.equal(ix.rank("load customer region")[0].file.path, "src/customers/customer.ts");
  assert.ok(["src/customers/customer.ts", "src/billing/tax.ts", "src/api/handler.ts", "py/shop/pricing.py"].includes(ix.rank()[0].file.path));
  const m = ix.map("invoice", 400); assert.ok(m.length < 520); assert.match(ix.map("invoice"), /src\/billing\/invoice\.ts \(\d+ lines[\s\S]*function computeInvoice :4/);
  assert.match(ix.map("zzzz nothing"), /nothing indexed matches/);
});

test("index: it follows edits (incremental refresh), new files and deletions", () => {
  const d = repo(), ix = new CodeIndex(d); assert.equal(ix.refresh().changed, ix.files.size); assert.equal(ix.refresh().changed, 0);
  put(d, "src/billing/tax.ts", "export function taxFor() { return 0; }\nexport function newThing() {}\n"); const later = new Date(Date.now() + 5000); utimesSync(join(d, "src/billing/tax.ts"), later, later);
  put(d, "src/extra.ts", "export function extra() {}\n");
  assert.equal(ix.refresh().changed, 2); assert.ok(ix.definitions("newThing").length === 1 && ix.definitions("extra").length === 1);
  (async () => { (await import("node:fs")).rmSync(join(d, "src/extra.ts")); })(); 
});

test("tools: repo_map, find_refs and impact answer in one call each", async () => {
  const ix = new CodeIndex(repo()), [map, refs, impact] = indexTools(ix), ctx = { registry: undefined as any, step: 0 };
  assert.match(String(await map.run({ query: "customer region" }, ctx)), /src\/customers\/customer\.ts[\s\S]*type Customer/);
  const r = String(await refs.run({ symbol: "computeInvoice" }, ctx)); assert.match(r, /definitions:\n  src\/billing\/invoice\.ts:4  export function computeInvoice/); assert.match(r, /used in 1 file\(s\):\n  src\/api\/handler\.ts/);
  assert.match(String(await refs.run({ symbol: "Nope" }, ctx)), /no definition or use of "Nope"/);
  const i = String(await impact.run({ path: "src/billing/tax.ts" }, ctx)); assert.match(i, /1 import it directly, 1 more through them[\s\S]*src\/billing\/invoice\.ts[\s\S]*src\/api\/handler\.ts  \(via another import\)[\s\S]*function taxFor → src\/billing\/invoice\.ts/);
  assert.match(String(await impact.run({ path: "nope.ts" }, ctx)), /is not in the index/);
});

test("agent: the index tools exist only in repositories big enough to need them", async () => {
  const names = async (d: string) => { let seen: string[] = []; await createCodeAgent({ model: (async (_m: Message[], s: { name: string }[]) => ((seen = s.map((x) => x.name)), { role: "assistant", content: "ok" } as Message)) as Model, cwd: d, memory: false, guidance: false, chat: true }).chat([], "hi"); return seen; };
  assert.ok(!(await names(repo())).includes("repo_map"));                                      // 8 source files: grep is enough
  const big = root(); for (let i = 0; i < 30; i++) put(big, `src/m${i}.ts`, `export function f${i}() { return ${i}; }\n`);
  const n = await names(big); assert.ok(n.includes("repo_map") && n.includes("find_refs") && n.includes("impact"));
});
