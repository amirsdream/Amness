// Skills in .claude/skills must not drift from the code: a skill that names a file, a command, a flag, a guard or a function that no longer
// exists gives wrong instructions without anyone noticing. This test fails as soon as that happens, so the skill is fixed in the same commit
// as the code. Copied (third-party) skills are checked by licence and fingerprint instead: their text is kept unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GUARD_NAMES } from "../src/harness.ts";

const root = process.cwd(), dir = join(root, ".claude", "skills");
const skills = existsSync(dir) ? readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "SKILL.md"))) : [];
const read = (p: string) => readFileSync(join(root, p), "utf8");
const cliSource = ["cli", "cli/tui"].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".ts")).map((f) => read(join(d, f)))).join("\n");
const scripts = Object.keys(JSON.parse(read("package.json")).scripts ?? {});
const REPO_PATH = /^(src|cli|test|docs|bench|scripts|examples|\.claude|\.github)\/[\w./-]*$|^(CHANGELOG|ROADMAP|README)\.md$|^package\.json$/;

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text); if (!m) return {};
  return Object.fromEntries(m[1].split("\n").map((l) => /^(\w[\w-]*):\s*(.*)$/.exec(l)).filter(Boolean).map((x) => [x![1], x![2].replace(/^"|"$/g, "")]));
}

test("skills: each has a name that matches its folder and a description", () => {
  assert.ok(skills.length > 0, "no skills found");
  for (const s of skills) {
    const fm = frontmatter(readFileSync(join(dir, s, "SKILL.md"), "utf8"));
    assert.equal(fm.name, s, `${s}: the name in SKILL.md must be the folder name`);
    assert.ok(fm.description && fm.description.length >= 20 && fm.description.length <= 1024, `${s}: description must be 20 to 1024 characters`);
  }
});

test("skills: a copied skill keeps its licence, its source commit and its recorded fingerprint (no silent local edits)", () => {
  for (const s of skills.filter((x) => existsSync(join(dir, x, "SOURCE.md")))) {
    const src = readFileSync(join(dir, s, "SOURCE.md"), "utf8");
    assert.ok(existsSync(join(dir, s, "LICENSE")), `${s}: a copied skill needs its LICENSE`);
    assert.match(src, /\b[0-9a-f]{40}\b/, `${s}: SOURCE.md must name the exact upstream commit`);
    const want = /SKILL\.md sha256: ([0-9a-f]{64})/.exec(src)?.[1];
    assert.ok(want, `${s}: SOURCE.md must record the SKILL.md sha256`);
    const got = createHash("sha256").update(readFileSync(join(dir, s, "SKILL.md"))).digest("hex");
    assert.equal(got, want, `${s}: SKILL.md differs from the copied version. Do not edit a copy: write our own skill, or copy the new upstream version and record its hash.`);
  }
});

test("skills: our own skills name only files, scripts, commands, flags, guards, functions and skills that exist", () => {
  const problems: string[] = [];
  for (const s of skills.filter((x) => !existsSync(join(dir, x, "SOURCE.md")))) {
    const text = readFileSync(join(dir, s, "SKILL.md"), "utf8");
    const lines = text.split("\n");
    const ticks = (l: string) => [...l.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
    for (const [i, line] of lines.entries()) {
      const at = `${s}/SKILL.md:${i + 1}`;
      for (const t of ticks(line)) {
        // files and folders of this repository (placeholders such as <name> and globs are not checked)
        const p = t.replace(/[.,;:]+$/, "");
        if (REPO_PATH.test(p) && !/[<>*]/.test(p) && !existsSync(join(root, p))) problems.push(`${at}: no such path ${p}`);
        // npm scripts
        for (const m of t.matchAll(/\bnpm run ([\w:-]+)/g)) if (!scripts.includes(m[1])) problems.push(`${at}: no npm script "${m[1]}"`);
        // amness subcommands and their flags
        const am = /^amness ([a-z]+)\b(.*)$/.exec(t);
        if (am) {
          if (!cliSource.includes(`"${am[1]}"`)) problems.push(`${at}: no amness subcommand "${am[1]}"`);
          for (const f of am[2].matchAll(/(?:^|\s)(--[a-z][\w-]*)/g)) if (!cliSource.includes(f[1])) problems.push(`${at}: no amness flag ${f[1]}`);
        }
        // guard names: off=<guard>, --off <guard>, full-<guard>
        for (const g of t.matchAll(/(?:\boff=|--off\s+|\bfull-)([a-z]+)\b/g)) if (!(GUARD_NAMES as readonly string[]).includes(g[1])) problems.push(`${at}: no guard "${g[1]}"`);
      }
      // "`fn` in `src/x.ts`", "`a`, `b` in `src/x.ts`" and "`src/x.ts` (`fn`)"
      for (const m of line.matchAll(/((?:`[\w.]+`(?:,\s*|\s+and\s+))*`[\w.]+`) in `((?:src|cli)\/[\w./-]+\.ts)`/g))
        for (const sym of [...m[1].matchAll(/`([\w.]+)`/g)].map((x) => x[1])) if (existsSync(join(root, m[2])) && !read(m[2]).includes(sym)) problems.push(`${at}: ${sym} is not in ${m[2]}`);
      for (const m of line.matchAll(/`((?:src|cli)\/[\w./-]+\.ts)` \(`([\w.]+)`\)/g)) if (existsSync(join(root, m[1])) && !read(m[1]).includes(m[2])) problems.push(`${at}: ${m[2]} is not in ${m[1]}`);
      // other skills it sends you to: "the `x` skill", "`x` skill"
      for (const m of line.matchAll(/`([a-z][a-z0-9-]+)` skill\b/g)) if (!skills.includes(m[1]) && !/local|if installed/i.test(line)) problems.push(`${at}: no skill "${m[1]}"`);
    }
  }
  assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});
