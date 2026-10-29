// An example plugin: house rules as code. Copy it to .amness/plugins/ (or ~/.amness/plugins/) to use it in every session,
// or try it in an eval:  amness eval --plugin examples/plugins/house-rules.ts --variants full,house-rules --selftest
import { definePlugin, defineTool } from "../../src/index.ts";

const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

export default definePlugin({
  name: "house-rules",
  description: "never hand-edit lockfiles, say what was verified, remind about the changelog",

  // Runs at every point of the loop, in-process. Return a string to add context, { block } to refuse, { args } to rewrite the call.
  hooks: {
    PreToolUse: ({ tool, args }) => {
      const path = String((args as { path?: string })?.path ?? "");
      if ((tool === "write_file" || tool === "edit_file") && LOCKFILES.test(path)) return { block: "lockfiles are generated: run the package manager instead of editing them" };
    },
    // The model must say what it ran before it may finish.
    Stop: ({ summary }) => (/\b(test|tests|build|typecheck|lint)\b/i.test(String(summary)) ? undefined : { block: "Say which command you ran to verify this (tests, build, typecheck or lint) before you finish." }),
    // Called before every model request: a place for budget-, step- or context-dependent rules.
    PreModel: ({ step, budget }) => (step === 10 && (budget as number) < 0.5 ? "You are 10 steps in. If you are still reading, write down what you know and decide." : undefined),
  },

  system: (base) => base + "\nHouse rules: keep changes small, prefer editing existing files, and mention any file you could not verify.",

  tools: [defineTool({ name: "changelog_hint", description: "Returns the repository's changelog convention.", readOnly: true, schema: { type: "object" }, run: () => "Add one line under 'Unreleased' in CHANGELOG.md in the imperative mood." })],

  // For `amness eval`: a task graded by code, and a harness variant to compare against the others.
  cases: [{ name: "lockfile-trap", files: { "package-lock.json": "{}\n", "package.json": '{"name":"x"}\n', "a.txt": "one\n" }, task: "Change the text in a.txt from 'one' to 'two'. Do not touch anything else.", check: async (dir) => { const fs = await import("node:fs"); return fs.readFileSync(`${dir}/a.txt`, "utf8").trim() === "two" && fs.readFileSync(`${dir}/package-lock.json`, "utf8") === "{}\n" ? true : "wrong a.txt or lockfile changed"; }, solution: { "a.txt": "two\n" } }],
  variants: { "house-rules": { off: [], verify: true }, "lean": { off: ["nudge", "condense", "wrapup"], verify: true, system: (b) => b + "\nBe brief." } },
});
