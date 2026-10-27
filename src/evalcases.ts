import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Case } from "./evals.ts";

/** Small, self-contained coding tasks (plain Node, no installs) with a visible `verify` command and a held-out `check` the agent never sees. */
export const builtinCases: Case[] = [
  {
    name: "off-by-one",
    files: {
      "sum.js": "exports.sumTo = (n) => { let s = 0; for (let i = 1; i < n; i++) s += i; return s; };\n",
      "test.js": "const a = require('assert'); const { sumTo } = require('./sum'); a.equal(sumTo(3), 6); a.equal(sumTo(1), 1);\n",
    },
    task: "sumTo(n) should return 1+2+...+n but tests fail. Fix the bug.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {sumTo}=require('./sum');process.exit(sumTo(10)===55&&sumTo(0)===0?0:1)\"",
    solution: { "sum.js": "exports.sumTo = (n) => { let s = 0; for (let i = 1; i <= n; i++) s += i; return s; };\n" },
  },
  {
    name: "missing-feature",
    files: {
      "slug.js": "exports.slugify = (s) => s.toLowerCase().replace(/ /g, '-');\n",
      "test.js": "const a = require('assert'); const { slugify } = require('./slug'); a.equal(slugify('Hello World'), 'hello-world'); a.equal(slugify(' Café  au lait! '), 'cafe-au-lait');\n",
    },
    task: "slugify must also strip accents and punctuation, trim, and collapse repeated separators. Make test.js pass.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {slugify}=require('./slug');process.exit(slugify('A--B  C!!')==='a-b-c'?0:1)\"",
    solution: { "slug.js": "exports.slugify = (s) => s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" },
  },
  {
    name: "rename-across-files",
    files: {
      "a.js": "exports.getUsr = () => ({ name: 'x' });\n",
      "b.js": "const { getUsr } = require('./a'); exports.hello = () => 'hi ' + getUsr().name;\n",
      "test.js": "const a = require('assert'); a.equal(require('./b').hello(), 'hi x'); a.equal(typeof require('./a').getUser, 'function');\n",
    },
    task: "Rename getUsr to getUser everywhere in this repo.",
    verify: "node test.js",
    check: "node test.js && ! grep -r getUsr a.js b.js",
    solution: { "a.js": "exports.getUser = () => ({ name: 'x' });\n", "b.js": "const { getUser } = require('./a'); exports.hello = () => 'hi ' + getUser().name;\n" },
  },
  {
    name: "noisy-test-output",
    files: {
      "stats.js": "exports.mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length + 1);\n",
      "test.js": "const a = require('assert'); const { mean } = require('./stats');\nfor (let i = 0; i < 1500; i++) console.log('\\x1b[32m✓\\x1b[0m case ' + i + ' ok');\na.equal(mean([2, 4, 6]), 4);\na.equal(mean([5]), 5);\nconsole.log('all good');\n",
    },
    task: "The test run prints a lot of output and then fails. Find and fix the bug in stats.js so test.js passes.",
    verify: "node test.js",
    check: "node test.js >/dev/null && node -e \"const {mean}=require('./stats');process.exit(mean([1,2,3,4])===2.5&&mean([10])===10?0:1)\"",
    solution: { "stats.js": "exports.mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;\n" },
  },
  {
    name: "two-bugs",
    files: {
      "clamp.js": "exports.clamp = (x, lo, hi) => (x < lo ? hi : x > hi ? lo : x);\n",
      "test.js": "const a = require('assert'); const { clamp } = require('./clamp'); a.equal(clamp(5, 0, 10), 5); a.equal(clamp(-1, 0, 10), 0); a.equal(clamp(11, 0, 10), 10);\n",
    },
    task: "clamp(x, lo, hi) misbehaves at both ends. Fix it and make test.js pass.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {clamp}=require('./clamp');process.exit(clamp(0,0,0)===0&&clamp(-5,-3,-1)===-3&&clamp(7,-3,-1)===-1?0:1)\"",
    solution: { "clamp.js": "exports.clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);\n" },
  },
  {
    name: "implement-parser",
    files: {
      "parse.js": "exports.parse = (text) => { throw new Error('not implemented'); };\n",
      "test.js": "const a = require('assert'); const { parse } = require('./parse');\na.deepEqual(parse('a=1\\nb = two'), { a: '1', b: 'two' });\na.deepEqual(parse('# comment\\n\\nname=x=y'), { name: 'x=y' });\n",
    },
    task: "Implement parse(text) in parse.js: key=value lines into an object, trimming whitespace, skipping blank lines and lines starting with #, splitting on the first '='. Make test.js pass.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {parse}=require('./parse');const r=parse('  k  =  v  \\n#x\\nz=');process.exit(r.k==='v'&&r.z===''&&Object.keys(r).length===2?0:1)\"",
    solution: { "parse.js": "exports.parse = (t) => { const o = {}; for (const l of t.split('\\n')) { const s = l.trim(); if (!s || s.startsWith('#')) continue; const i = s.indexOf('='); if (i < 0) continue; o[s.slice(0, i).trim()] = s.slice(i + 1).trim(); } return o; };\n" },
  },
  {
    name: "bug-in-a-helper",
    files: {
      "util.js": "exports.pad2 = (n) => (n < 10 ? '0' + n : String(n)).slice(-1);\n",
      "time.js": "const { pad2 } = require('./util'); exports.hhmm = (h, m) => pad2(h) + ':' + pad2(m);\n",
      "date.js": "const { pad2 } = require('./util'); exports.ymd = (y, m, d) => y + '-' + pad2(m) + '-' + pad2(d);\n",
      "test.js": "const a = require('assert'); a.equal(require('./time').hhmm(9, 5), '09:05'); a.equal(require('./date').ymd(2026, 3, 7), '2026-03-07');\n",
    },
    task: "test.js fails with wrong formatting in both time.js and date.js. Find the root cause and fix it once.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {pad2}=require('./util');process.exit(pad2(12)==='12'&&pad2(0)==='00'?0:1)\" && ! grep -q slice\\(-1\\) util.js",
    solution: { "util.js": "exports.pad2 = (n) => (n < 10 ? '0' + n : String(n));\n" },
  },
  {
    name: "add-validation",
    files: {
      "account.js": "exports.withdraw = (balance, amount) => balance - amount;\n",
      "test.js": "const a = require('assert'); const { withdraw } = require('./account');\na.equal(withdraw(100, 30), 70);\na.throws(() => withdraw(100, 200), /insufficient/i);\na.throws(() => withdraw(100, -5), /invalid/i);\n",
    },
    task: "withdraw must reject overdrafts (throw an Error mentioning 'insufficient funds') and non-positive or non-numeric amounts (throw an Error mentioning 'invalid amount'). Make test.js pass.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {withdraw}=require('./account');let ok=0;for(const x of [0,'5',NaN]){try{withdraw(10,x)}catch(e){if(/invalid/i.test(e.message))ok++}}process.exit(ok===3&&withdraw(10,10)===0?0:1)\"",
    solution: { "account.js": "exports.withdraw = (b, a) => { if (typeof a !== 'number' || !(a > 0)) throw new Error('invalid amount'); if (a > b) throw new Error('insufficient funds'); return b - a; };\n" },
  },
];

/** Cases from a folder of `*.json` files (`{ name?, files, task, verify?, check }`; `check` is a shell command), so you can evaluate on your own tasks. */
export function loadCases(dir: string): Case[] {
  if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`);
  const out: Case[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (!j || typeof j.task !== "string" || typeof j.check !== "string" || typeof j.files !== "object") throw new Error(`${f}: needs "task", "files" (path -> text) and "check" (shell command)`);
    out.push({ name: j.name ?? f.replace(/\.json$/, ""), files: j.files, task: j.task, verify: j.verify, check: j.check });
  }
  if (!out.length) throw new Error(`no *.json cases in ${dir}`);
  return out;
}
