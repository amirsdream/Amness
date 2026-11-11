// The qualification ladder: which level of tool use a model clears, so a job is given by measurement, not by model size.
// Small models were reliable for single tool calls, usable for two-step chains and unreliable from branching upward; no model was reliable
// on long-horizon planning (AgentFloor, arXiv 2605.00334, read). Five levels, graded deterministically, in plain Node. `amness eval --builtin ladder`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Case, Row } from "./evals.ts";

export const LADDER_SUITE_VERSION = "ladder-1";
const answer = (dir: string) => { try { return readFileSync(`${dir}/ANSWER.txt`, "utf8"); } catch { return ""; } };

export const ladderCases: Case[] = [
  {
    name: "L1-single-read",
    files: { "config/app.json": JSON.stringify({ name: "shop", port: 8417, debug: false }, null, 2) + "\n" },
    task: "Which port does the app use? Read config/app.json and write only the number into ANSWER.txt. Do not change any other file.",
    verify: "test -s ANSWER.txt",
    check: (dir: string) => (/^\s*8417\s*$/.test(answer(dir)) ? true : "wrong port"),
    solution: { "ANSWER.txt": "8417\n" },
  },
  {
    name: "L2-search-then-read",
    files: Object.fromEntries([
      ...Array.from({ length: 20 }, (_, i) => [`src/m${i}.js`, `// module ${i}\nexports.f${i} = () => ${i};\n`]),
      ["src/limits.js", "// request limits\nconst WINDOW = 60;\nexports.MAX_UPLOAD_MB = 37;\nexports.WINDOW = WINDOW;\n"],
    ]),
    task: "Find where MAX_UPLOAD_MB is defined in src/ (search for it, then read that file) and write its value, only the number, into ANSWER.txt.",
    verify: "test -s ANSWER.txt",
    check: (dir: string) => (/^\s*37\s*$/.test(answer(dir)) ? true : "wrong value"),
    solution: { "ANSWER.txt": "37\n" },
  },
  {
    name: "L3-branch-on-result",
    files: {
      "flags.json": JSON.stringify({ newCheckout: true }) + "\n",
      "checkout/old.js": "exports.fee = 5;\n",
      "checkout/new.js": "exports.fee = 3;\n",
    },
    task: "Read flags.json. If newCheckout is true, the fee is the one in checkout/new.js; otherwise it is the one in checkout/old.js. Write that fee, only the number, into ANSWER.txt.",
    verify: "test -s ANSWER.txt",
    check: (dir: string) => (/^\s*3\s*$/.test(answer(dir)) ? true : "took the wrong branch"),
    solution: { "ANSWER.txt": "3\n" },
  },
  {
    name: "L4-reconcile-sources",
    files: {
      "README.md": "# cache\nEntries expire after 10 minutes.\n",
      "docs/cache.md": "The cache TTL is 15 minutes (changed in v2).\n",
      "src/cache.js": "// the real setting; the docs were not updated after v3\nexports.TTL_SECONDS = 1200;\n",
    },
    task: "The documents disagree about how long cache entries live. Find what the code really uses and write it into ANSWER.txt as a number of minutes, only the number.",
    verify: "test -s ANSWER.txt",
    check: (dir: string) => (/^\s*20\s*$/.test(answer(dir)) ? true : "did not follow the code (20 minutes)"),
    solution: { "ANSWER.txt": "20\n" },
  },
  {
    name: "L5-constrained-change",
    files: {
      "src/price.js": "exports.withTax = (net) => net * 1.2;\n",
      "src/cart.js": "const { withTax } = require('./price');\nexports.total = (items) => items.reduce((s, i) => s + withTax(i.net), 0);\n",
      "test/cart.test.js": "const assert = require('assert');\nconst { total } = require('../src/cart');\nassert.strictEqual(total([{ net: 10, qty: 3 }]), 36);\nassert.strictEqual(total([{ net: 5 }]), 6);\nconsole.log('ok');\n",
    },
    task: "Items in a cart can have a quantity (qty, default 1). Make total() count it, so node test/cart.test.js passes. Do not change the test file, and keep withTax in src/price.js.",
    verify: "node test/cart.test.js",
    check: (dir: string) => {
      try {
        const t = readFileSync(`${dir}/test/cart.test.js`, "utf8"), p = readFileSync(`${dir}/src/price.js`, "utf8");
        if (!t.includes("qty: 3 }]), 36)")) return "the test was changed";
        if (!/withTax/.test(p)) return "withTax was removed";
      } catch { return "files missing"; }
      try { execFileSync(process.execPath, ["test/cart.test.js"], { cwd: dir, stdio: "pipe", timeout: 20_000 }); return true; } catch { return "node test/cart.test.js fails"; }
    },
    solution: { "src/cart.js": "const { withTax } = require('./price');\nexports.total = (items) => items.reduce((s, i) => s + withTax(i.net) * (i.qty ?? 1), 0);\n" },
  },
];

/** Which jobs each cleared level allows (cleared = every case up to that level passed in every trial). */
export const LEVEL_ROLES: Record<number, string[]> = { 1: ["compact", "quarantine", "advisor"], 3: ["explore"], 4: ["review", "approve"], 5: ["main", "edit"] };

/** The highest level a variant cleared, and the jobs that gives. */
export function ladderVerdict(rows: Row[], variant: string): { level: number; roles: string[]; failed?: string } {
  const r = rows.filter((x) => x.variant === variant && !x.excluded);
  let level = 0, failed: string | undefined;
  for (let k = 1; k <= 5; k++) { const runs = r.filter((x) => x.case.startsWith(`L${k}-`)); if (!runs.length || runs.some((x) => !x.pass)) { failed = runs.length ? runs[0].case : `L${k} (not run)`; break; } level = k; }
  const roles = Object.entries(LEVEL_ROLES).filter(([k]) => Number(k) <= level).flatMap(([, v]) => v);
  return { level, roles, ...(failed && { failed }) };
}
