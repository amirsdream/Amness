// The claims ledger: what actually happened (files changed, commands run and their exit codes), recorded from tool events, never from the model's own words.
// At `finish` the model's summary is checked against it, because agents that grade their own work accept plausible-sounding progress as real progress.
export type LedgerEdit = { path: string; added: number; removed: number; created: boolean; seq: number };
export type LedgerCmd = { cmd: string; code: number | null; test: boolean; build: boolean; failedOutput: boolean; seq: number };
export type Audit = { changed: string[]; testsAfterLastEdit: boolean | undefined; notes: string[] };

export const TEST_CMD = /\b(npm\s+(run\s+)?t(est)?\b|yarn\s+test|pnpm\s+(run\s+)?test|npx\s+(jest|vitest|mocha|ava|tap)|jest|vitest|mocha|pytest|python3?\s+-m\s+(pytest|unittest)|go\s+test|cargo\s+(test|nextest)|mvn\s+(-\S+\s+)*test|gradle\w*\s+test|dotnet\s+test|make\s+(test|check)|rspec|phpunit|node\s+(--test\b|\S*test\S*\.[cm]?js)|bun\s+test|deno\s+test|ctest|swift\s+test)\b/i;
export const BUILD_CMD = /\b(tsc\b|npm\s+run\s+(build|typecheck|lint|check)|yarn\s+(build|lint)|cargo\s+(build|check|clippy)|go\s+(build|vet)|make\b|mvn\s+(-\S+\s+)*(compile|package)|gradle\w*\s+build|eslint|ruff|mypy|pyright|next\s+build|vite\s+build|webpack)\b/i;
const FAIL_OUTPUT = /(?:^|\n)\s*(?:FAIL\b|✖|not ok\b)|\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing)\b|\b(?:failed|failing):\s*[1-9]|Tests:\s+\d+\s+failed|AssertionError|[1-9]\d*\s+errors?\b/i;
const SHELL_WRITE = /\bsed\s+-i|>\s*[\w./~-]|\btee\b|\bmv\b|\bcp\b|\bgit\s+(apply|checkout|restore|stash|reset|mv)\b|\bpatch\b|\bperl\s+-p?i|\btouch\b|\bmkdir\b/;
const NEG = /\b(?:not|n't|no|never|without|fail\w*|broken|still)\b[^.\n]{0,25}$/i;

export class Ledger {
  edits: LedgerEdit[] = []; cmds: LedgerCmd[] = []; private seq = 0; private extraTest?: RegExp;
  constructor(o: { testCommand?: string } = {}) { if (o.testCommand) this.extraTest = new RegExp(o.testCommand.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")); }
  reset() { this.edits = []; this.cmds = []; this.seq = 0; }

  onEdit(e: { path: string; added: number; removed: number; created: boolean }) { this.edits.push({ path: e.path, added: e.added, removed: e.removed, created: e.created, seq: ++this.seq }); }
  /** Record a shell command from its tool result (`exit=N\n...`). */
  onCommand(cmd: string, result: string) {
    const m = /^exit=(\d+)/.exec(result), code = m ? Number(m[1]) : /^exit=/.test(result) ? null : null;
    this.cmds.push({ cmd, code: m ? code : null, test: TEST_CMD.test(cmd) || !!this.extraTest?.test(cmd), build: BUILD_CMD.test(cmd), failedOutput: FAIL_OUTPUT.test(result), seq: ++this.seq });
  }
  private lastEdit() { return this.edits.at(-1)?.seq ?? 0; }
  private ok(c: LedgerCmd) { return c.code === 0 && !c.failedOutput; }
  /** A passing test run (or build) that happened after the last edit. */
  private passedAfterEdit(kind: "test" | "build") { const le = this.lastEdit(); return this.cmds.some((c) => c[kind] && c.seq > le && this.ok(c)); }
  private ranAny(kind: "test" | "build") { return this.cmds.some((c) => c[kind]); }
  private shellWrote() { return this.cmds.some((c) => SHELL_WRITE.test(c.cmd)); }

  /** Problems with the claims in `summary`, judged against what was recorded. `gated`: a verify command already proved the result. */
  check(summary: string, o: { gated?: boolean } = {}): string[] {
    const problems: string[] = [], s = summary;
    const claimed = (re: RegExp) => { for (const m of s.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) { if (!NEG.test(s.slice(Math.max(0, m.index! - 30), m.index!))) return true; } return false; };
    const testClaim = /\b(?:all\s+)?(?:unit\s+|integration\s+)?(?:tests?|specs?|test suite|suite)\b[^.\n]{0,40}?\b(?:pass(?:es|ed|ing)?|green|succe(?:ed|eds|eded|ssful)|ok)\b|\b(?:pass(?:es|ed|ing)?)\b[^.\n]{0,15}\b(?:tests?|suite)\b|\b\d+\s*\/\s*\d+\s+(?:tests?\s+)?pass/i;
    const buildClaim = /\b(?:build|compil\w+|type-?check\w*|lint\w*)\b[^.\n]{0,30}?\b(?:pass(?:es|ed)?|succe\w+|clean|ok|works?|without errors)\b/i;
    if (!o.gated && claimed(testClaim)) {
      if (!this.ranAny("test")) problems.push("you say the tests pass, but no test command was run in this session. Run the tests, or remove the claim.");
      else if (!this.passedAfterEdit("test")) problems.push(this.edits.length && this.cmds.some((c) => c.test && !this.ok(c) && c.seq > this.lastEdit()) ? "you say the tests pass, but the last test run after your final edit failed." : "you say the tests pass, but no test run succeeded after your last edit. Run them again.");
    }
    if (!o.gated && claimed(buildClaim) && !this.passedAfterEdit("build") && !this.passedAfterEdit("test")) problems.push("you say the build/typecheck/lint is clean, but no such command succeeded after your last edit.");
    if (!this.shellWrote()) {
      const verbs = /\b(?:fix(?:ed)?|updat(?:ed?)|chang(?:ed?)|add(?:ed)?|implement(?:ed)?|modif(?:y|ied)|edit(?:ed)?|renam(?:ed?)|creat(?:ed?)|remov(?:ed?)|delet(?:ed?)|refactor(?:ed)?|rewr(?:ote|itten))\b[^.;()\n]{0,30}?`?([\w@./-]+\.[A-Za-z]{1,5})`?/gi;
      const touched = new Set(this.edits.map((e) => e.path.replace(/^\.\//, "")));
      const missing = [...new Set([...s.matchAll(verbs)].map((m) => m[1].replace(/^\.\//, "")))].filter((p) => p.includes("/") || /\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|css|html|json|md|ya?ml|toml|sh|c|cc|cpp|h)$/.test(p)).filter((p) => ![...touched].some((t) => t === p || t.endsWith("/" + p) || p.endsWith("/" + t)));
      if (missing.length) problems.push(`the summary says ${missing.slice(0, 3).join(", ")} ${missing.length === 1 ? "was" : "were"} changed, but no edit to ${missing.length === 1 ? "it" : "them"} was recorded.`);
    }
    return problems;
  }

  /** A short factual record of the run, for the user. */
  audit(task: string): Audit {
    const changed = [...new Set(this.edits.map((e) => e.path))], notes: string[] = [];
    const tests = changed.filter((p) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i.test(p));
    if (tests.length && !/\b(tests?|specs?)\b/i.test(task)) notes.push(`test files were modified although the task did not mention tests: ${tests.slice(0, 3).join(", ")}`);
    if (changed.length > 8) notes.push(`${changed.length} files changed, which is a lot for one task: check the diff`);
    const testsAfter = this.edits.length ? (this.ranAny("test") ? this.passedAfterEdit("test") : undefined) : undefined;
    if (this.edits.length && testsAfter === undefined) notes.push("no test command was run");
    else if (testsAfter === false) notes.push("the last test run after the final edit did not pass");
    return { changed, testsAfterLastEdit: testsAfter, notes };
  }
}
