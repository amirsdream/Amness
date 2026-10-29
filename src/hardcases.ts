// Harder tasks than the built-in suite: a model that solves every easy task cannot show that a guard helps. These have hidden edge cases, misleading symptoms, a question to answer
import { readFileSync } from "node:fs";
// from a mid-sized repository, and cost of exploring. Plain Node, no installs. `amness eval --builtin hard`.
import type { Case } from "./evals.ts";

const exploreAnswer = (): Case => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 48; i++) files[`src/mod${i}/index.js`] = `// module ${i}\nexports.name = 'mod${i}';\nexports.log = (m) => console.log('[mod${i}]', m);\n`;
  files["src/auth/login.js"] = "const { write } = require('../audit/writer');\nexports.login = (u, p) => { if (p !== 'x') { write('login-failed', u); return false; } return true; };\n";
  files["src/audit/writer.js"] = "const { RETENTION } = require('./policy');\nexports.write = (kind, who) => ({ kind, who, expires: RETENTION });\n";
  files["src/audit/policy.js"] = "// Audit entries older than this many days are purged by the nightly job.\nexports.RETENTION = 90;\n";
  files["src/audit/legacy.js"] = "// DEPRECATED, unused. The old writer kept entries for 30 days.\nexports.RETENTION_LEGACY = 30;\nexports.writeLegacy = () => null;\n";
  files["src/billing/audit.js"] = "// billing audit trail (unrelated to logins); keeps 365 days\nexports.RETENTION = 365;\n";
  files["README.md"] = "# service\nSee src/ for modules. There is no architecture document.\n";
  return {
    name: "explore-answer", files,
    task: "Question about this repository (do not change any code): when a login fails, which function records the audit entry (give the name of the exported function in the file that builds the entry), and for how many days are those audit entries kept? Write the answer to ANSWER.txt as two lines: `function: <name>` and `days: <number>`.",
    verify: "test -s ANSWER.txt",
    check: (dir: string) => { try { const a = readFileSync(`${dir}/ANSWER.txt`, "utf8"); return /function:\s*write\b/i.test(a) && /days:\s*90\b/.test(a) ? true : "wrong or missing answer"; } catch { return "no ANSWER.txt"; } },
    solution: { "ANSWER.txt": "function: write\ndays: 90\n" },
  } as Case;
};

export const hardCases: Case[] = [
  exploreAnswer(),
  {
    name: "misleading-symptom",
    files: {
      "dates.js": "// Parses 'YYYY-MM-DD' into a Date at local midnight.\nexports.parseDay = (s) => new Date(s);\n",
      "format.js": "exports.label = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + d.getDate();\n",
      "report.js": "const { parseDay } = require('./dates'); const { label } = require('./format');\nexports.heading = (s) => label(parseDay(s));\n",
      "test.js": "const a = require('assert'); const { heading } = require('./report');\na.equal(heading('2024-03-10'), 'Sun 10');\n",
    },
    task: "heading('2024-03-10') should be 'Sun 10' but the test fails in some time zones (run it with TZ=America/Los_Angeles to see). The label formatting looks suspicious. Fix it so the test passes in every time zone.",
    verify: "TZ=America/Los_Angeles node test.js",
    check: "TZ=America/Los_Angeles node test.js && TZ=Pacific/Auckland node test.js && TZ=UTC node test.js && TZ=Pacific/Kiritimati node -e \"const {heading}=require('./report');process.exit(heading('2024-12-31')==='Tue 31'&&heading('2024-01-01')==='Mon 1'?0:1)\"",
    solution: { "dates.js": "exports.parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };\n" },
  },
  {
    name: "spec-in-docs",
    files: {
      "docs/SPEC.md": "# parseDuration(text)\nReturns milliseconds.\n- Units: `d` days, `h` hours, `m` minutes, `s` seconds, `ms` milliseconds.\n- Parts may be combined and are summed: `1h30m` = 5400000.\n- Whitespace between parts is allowed: `2d 4h`.\n- Parts may be in any order and units may repeat: `30m1h`.\n- A bare number with no unit is an error.\n- An empty string, an unknown unit or any other text throws `Error('invalid duration')`.\n- Negative numbers are not allowed.\n",
      "duration.js": "exports.parseDuration = (text) => { throw new Error('not implemented'); };\n",
      "test.js": "const a = require('assert'); const { parseDuration: p } = require('./duration');\na.equal(p('1h30m'), 5400000); a.equal(p('90s'), 90000); a.throws(() => p('abc'), /invalid duration/);\n",
    },
    task: "Implement parseDuration in duration.js as described in docs/SPEC.md. test.js has a few examples; the spec is the authority.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {parseDuration:p}=require('./duration');const t=(f)=>{try{f();return false}catch(e){return /invalid duration/.test(e.message)}};process.exit(p('2d 4h')===187200000&&p('30m1h')===5400000&&p('5ms')===5&&p('1s1s')===2000&&t(()=>p(''))&&t(()=>p('10'))&&t(()=>p('5x'))&&t(()=>p('-5s'))&&t(()=>p('1h foo'))?0:1)\"",
    solution: { "duration.js": "const U = { d: 864e5, h: 36e5, m: 6e4, s: 1e3, ms: 1 };\nexports.parseDuration = (text) => { const t = String(text).trim(); if (!t) throw new Error('invalid duration'); const re = /(\\d+)\\s*(ms|d|h|m|s)/y; let i = 0, sum = 0; while (i < t.length) { re.lastIndex = i; const m = re.exec(t); if (!m) throw new Error('invalid duration'); sum += Number(m[1]) * U[m[2]]; i = re.lastIndex; while (t[i] === ' ') i++; } return sum; };\n" },
  },
  (() => {
    const files: Record<string, string> = {
      "api.js": "exports.getUser = (id) => ({ id, name: 'u' + id });\n",
      "handlers.js": "const api = require('./api');\nexports.dispatch = (action, arg) => api[action](arg);\n",
      "routes.js": "const { dispatch } = require('./handlers');\nexports.show = (id) => dispatch('getUser', id);\n",
      "docs.md": "Call `getUser(id)` to load an account.\n",
      "test.js": "const a = require('assert'); const { show } = require('./routes'); const api = require('./api');\na.equal(show(3).name, 'u3'); a.equal(typeof api.fetchAccount, 'function');\n",
    };
    for (let i = 0; i < 5; i++) files[`feature${i}.js`] = `const { getUser } = require('./api');\nexports.run${i} = (id) => getUser(id).name + '${i}';\n`;
    return {
      name: "rename-with-string-dispatch", files,
      task: "Rename `getUser` to `fetchAccount` everywhere it is used (code, string-based dispatch and docs). No occurrence of getUser may remain. Make test.js pass.",
      verify: "node test.js",
      check: "node test.js && ! grep -rq getUser --include=*.js --include=*.md . && node -e \"const f=require('./feature2');process.exit(f.run2(7)==='u72'?0:1)\"",
      solution: Object.fromEntries([["api.js", "exports.fetchAccount = (id) => ({ id, name: 'u' + id });\n"], ["routes.js", "const { dispatch } = require('./handlers');\nexports.show = (id) => dispatch('fetchAccount', id);\n"], ["docs.md", "Call `fetchAccount(id)` to load an account.\n"], ...Array.from({ length: 5 }, (_, i) => [`feature${i}.js`, `const { fetchAccount } = require('./api');\nexports.run${i} = (id) => fetchAccount(id).name + '${i}';\n`])]),
    } as Case;
  })(),
  {
    name: "async-order",
    files: {
      "queue.js": "// Runs jobs and returns results in the order the jobs were submitted.\nexports.runAll = async (jobs) => { const out = []; await Promise.all(jobs.map(async (j) => { out.push(await j()); })); return out; };\n",
      "test.js": "const a = require('assert'); const { runAll } = require('./queue');\n(async () => { const r = await runAll([async () => 'a', async () => 'b']); a.deepEqual(r, ['a', 'b']); })();\n",
    },
    task: "runAll must return results in submission order, also when jobs finish out of order, and it should still run the jobs concurrently (not one after another). test.js passes by luck today. Fix runAll.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {runAll}=require('./queue');const d=(ms,v)=>()=>new Promise(r=>setTimeout(()=>r(v),ms));const t0=Date.now();runAll([d(120,'a'),d(10,'b'),d(60,'c')]).then(r=>process.exit(JSON.stringify(r)==='[\\\"a\\\",\\\"b\\\",\\\"c\\\"]'&&Date.now()-t0<250?0:1))\"",
    solution: { "queue.js": "exports.runAll = (jobs) => Promise.all(jobs.map((j) => j()));\n" },
  },
  {
    name: "slow-lookup",
    files: {
      "dedupe.js": "// Returns the items of `xs` with duplicates removed, keeping first occurrences in order.\nexports.dedupe = (xs) => { const out = []; for (const x of xs) { if (!out.some((y) => y === x)) out.push(x); } return out; };\n",
      "test.js": "const a = require('assert'); const { dedupe } = require('./dedupe');\na.deepEqual(dedupe([1, 2, 1, 3, 2]), [1, 2, 3]);\n",
    },
    task: "dedupe is far too slow on large inputs (it times out on 200000 items). Make it fast without changing what it returns: first occurrences kept, original order, NaN counts as equal to NaN.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {dedupe}=require('./dedupe');const xs=Array.from({length:200000},(_, i)=>i%50000);const t=Date.now();const r=dedupe(xs);const n=dedupe([NaN,1,NaN,1]);process.exit(r.length===50000&&r[49999]===49999&&n.length===2&&Date.now()-t<1500?0:1)\"",
    solution: { "dedupe.js": "exports.dedupe = (xs) => [...new Set(xs)];\n" },
  },
];
