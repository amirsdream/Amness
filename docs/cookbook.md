# Cookbook: short recipes

Each recipe shows one task you may want to do, with the exact commands and what you will see.

In this page you will learn how to:

- run Amness in CI, with several attempts or with parts in parallel
- control cost, and use a local model
- add your own rules, and measure them
- replay, review and schedule work

Commands marked "calls your model" cost tokens. The others call no model.

## 1. Run a fix in CI, with several attempts

*Calls your model.* Use `amness run` for a one-shot run with no terminal. `--verify` is a command that must exit 0 before the agent may finish.

```bash
amness run --verify "npm test" --json "fix the failing test"
```

You will see one JSON event per line, then a last line with `"kind":"result"`. The exit code is `0` if the agent finished, `1` if it did not, and `2` for a usage or configuration error. Risky commands are denied unless you add `--yes`.

Project hooks and plugins are skipped in headless runs unless you add `--trust-project`. See [Headless and CI](headless.md).

Want more than one try? Add `--best-of 3`. Amness then runs the task up to three times in separate git worktrees and stops at the first attempt that passes `--verify`. It applies that result to your folder.

```bash
amness run --best-of 3 --verify "npm test" "fix the failing test"
```

While it runs, you will see lines such as `attempt 1: failed verify (41200 tokens)`. At the end you will see `attempt 2 won and was applied`. If no attempt passes, you see `no attempt passed npm test (3 tried, N tokens)`. `--verify` is required, and the folder must be a git repository with at least one commit. The token cap is shared between the attempts. Whether best-of-n improves results is not measured yet.

## 2. Split work into parts

*Calls your model.* `--parts` runs independent tasks at the same time, each in its own worktree. Amness merges them one at a time and runs `--verify` after each merge.

1. Write `parts.json`:

   ```json
   [
     { "name": "docs", "task": "Fix the typos in README.md" },
     { "name": "tests", "task": "Add a test for the parse function in src/parse.ts" }
   ]
   ```

2. Run it:

   ```bash
   amness run --parts parts.json --verify "npm test"
   ```

You will see one line per part, with a status such as `merged`, `conflict`, `failed-verify`, `broke-verify`, `no-change`, `error` or `skipped-budget`. A conflict is reported and not applied. The exit code is `0` only if every part is `merged`. Use parts only for work that does not touch the same files.

## 3. Limit cost

The cap is the most tokens one turn may use. Cached input counts as a tenth, because it costs less.

In the chat:

```text
/budget
/budget 500k
```

The first line shows the cap, and the tokens used in the last turn. The second sets a new cap. The cap must be at least 10000 tokens. You can write `400000`, `400k` or `1m`.

At 50%, 75% and 90% of the cap, Amness tells the model to wrap up. Just before the cap, the model writes a short final report. In a headless run, use a flag:

```bash
amness run --max-tokens 200000 --verify "npm test" "fix the failing test"
```

The default for headless runs is 300000. A very small cap can stop a task before it is done. See [Budgets and subagents](budgets.md).

## 4. Use a local model

Any server with an OpenAI-compatible `/v1` address works. Ollama is one example.

```bash
ollama pull qwen2.5-coder:7b
amness run --provider ollama --model qwen2.5-coder:7b "list the TODO comments in src"
```

In the chat, pick the provider and model with `/provider` and `/model` instead: the interactive `amness` command does not read `--provider` or `--model`.

The address defaults to `http://localhost:11434/v1`. For another server, use `amness run --provider custom --base-url http://localhost:1234/v1 --model <model-name>`. You need no API key for a local server.

Limits: the model must support tool calling. Small models often work better with `/mode plan` and a `--max-tokens` limit. How well any local model performs is not measured here. To measure it, run `amness eval --variants ab` with that model. See [Providers and models](providers.md).

## 5. Add a house rule as a plugin

A plugin can block an action in code. This one blocks hand edits of `package-lock.json`.

1. Save `.amness/plugins/no-lockfiles.ts`:

   ```ts
   export default {
     name: "no-lockfiles",
     hooks: {
       PreToolUse: ({ tool, args }: { tool: string; args: any }) =>
         (tool === "write_file" || tool === "edit_file") && /package-lock\.json$/.test(String(args.path))
           ? { block: "lockfiles are generated: run the package manager instead" }
           : undefined,
     },
   };
   ```

2. Start `amness` and choose "Yes, trust this version" when it asks.
3. Type `/plugins`. You will see `no-lockfiles` and `hooks: PreToolUse`.

When the agent tries to edit the lockfile, it gets `BLOCKED BY A HOOK: lockfiles are generated: run the package manager instead`. See [Plugins](plugins.md) for the full steps.

## 6. Compare two harness variants

*Calls your model.* First check the tasks. This is free.

```bash
amness eval --selftest
```

Then compare the full harness with the one that has the reviewer:

```bash
amness eval --variants full,full+review --trials 3 --jobs 2
```

Amness prints a plan and asks before it starts. Add `--yes` to skip the question. You will see a table with `pass [95% CI]`, `pass^3`, `tok/solved`, `cache`, `steps`, `secs` and `pareto`, and a second table with the change against the first variant. A `verdict` of `inconclusive` means the data cannot tell. See [Evaluating the harness](evaluation.md) for how to read each column.

## 7. Write your own eval task

Use a task from your own work. A task is a JSON file with files, a task text and a held-out check.

1. Save `my-tasks/fix-add.json`:

   ```json
   {
     "name": "fix-add",
     "files": {
       "add.js": "exports.add = (a, b) => a - b;\n",
       "test.js": "const { add } = require('./add');\nif (add(2, 3) !== 5) process.exit(1);\n"
     },
     "task": "The add function is wrong. Fix it.",
     "verify": "node test.js",
     "check": "node test.js",
     "solution": { "add.js": "exports.add = (a, b) => a + b;\n" }
   }
   ```

2. Check it. This calls no model:

   ```bash
   amness eval --cases ./my-tasks --selftest
   ```

   You will see `ok  fix-add`.

3. Run it (calls your model):

   ```bash
   amness eval --cases ./my-tasks --variants ab --trials 3
   ```

One task is too few to compare variants. Add more tasks first.

## 8. Replay a saved trace after you change the harness

Replay feeds a recorded session back through the current harness. It calls no model and runs no tool. Only the harness rules can differ, so you can test a change for free.

1. Find a trace. Chat sessions write them to `.amness/traces/`. For a headless run, add `--trace`:

   ```bash
   ls .amness/traces
   ```

2. Replay one, here with the `nudge` guard off:

   ```bash
   amness replay .amness/traces/<session>.jsonl --off nudge
   ```

   Replace `<session>` with a file name from step 1.

You will see a line such as `run 1: 12 model turn(s), identical harness behaviour`, or `3 difference(s)` followed by lines that start with `- recorded only:` and `+ replay only:`. The exit code is `0` if all runs match and `1` if not. Other flags are `--stagnation-turns n`, `--max-steps n` and `--context-budget chars`.

Limits: after the first difference, the recording no longer matches what the model would have said, so later lines are only a hint. Old traces without model messages cannot be replayed.

## 9. Find recurring failures

Amness reads your session traces and groups what went wrong.

```bash
amness traces
```

You will see a summary line, then patterns with a count, for example `24×  ran out of budget: budget N% used  (10 sessions)`, and the sessions with the most trouble. In the chat, type `/report` for the same view.

To keep a failure from coming back, turn it into an eval task. The `--check` command must exit 0 only when the task is really done:

```bash
amness traces --case my-bug --task "Fix the date parsing bug" --check "npm test"
```

Amness copies the tracked files at git `HEAD` to `.amness/evals/cases/my-bug.json`. Run it with `amness eval --cases .amness/evals/cases --variants ab --trials 3`.

## 10. Schedule a nightly run

*Calls your model when the job runs.* Schedules use cron. The five fields are minute, hour, day of month, month and day of week.

1. Add a schedule for this project (3:00 on weekdays):

   ```bash
   amness schedule add nightly "0 3 * * 1-5" "run the tests and fix small failures" --verify "npm test"
   ```

   You will see the text: saved "nightly". Run `amness schedule install` to see the crontab line.

2. Look at the crontab line. This writes nothing:

   ```bash
   amness schedule install
   ```

3. Put it in your crontab:

   ```bash
   amness schedule install --write
   ```

Other commands are `amness schedule list`, `amness schedule remove nightly` and `amness schedule uninstall`. Amness only changes a marked block for this project in your crontab.

Each run is `amness run --json`, so risky commands are denied. The output goes to `.amness/schedule-logs/nightly.jsonl`. Cron must be able to find `amness` and your API key. Set them in the crontab environment or use a wrapper script. Cron names such as `MON` are not accepted. Use numbers.

## 11. Use it from an editor

Editors such as Zed and JetBrains can start Amness as their coding agent with the Agent Client Protocol (ACP). You do not run the command by hand.

For Zed, add this to your settings:

```json
"agent_servers": { "Amness": { "command": "amness", "args": ["acp"] } }
```

Amness uses your configured provider and model. When the agent wants to do something risky, the editor shows a permission request with the choices Allow and Reject.

Limits: Amness does not implement `session/load`, `authenticate`, `fs/*` or `terminal/*`. Only the Zed setting above comes from the built-in help. JetBrains setup is not verified here.

## 12. Review your changes before a pull request

In the chat, inside a git repository:

```text
/review
```

The agent reads your changes against the base branch and lists findings, or says `review: no problems found`. Use `/review main` to name the base branch. The review is read-only and costs model calls.

To create the pull request:

```text
/pr
```

Amness drafts a title and a description from your diff and commits. It shows them and asks "Create this pull request on GitHub?" with "Create it", "Create it as a draft" and "Cancel". If the branch is not on the remote, it asks before it pushes. Use `/pr draft` for a draft.

Limits: `/pr` needs the GitHub CLI (`gh`) and a branch that is not the base branch. It creates nothing without your choice.

## 13. Write a finish gate

A *finish gate* is a check that must pass before the agent may finish. Save `.amness/plugins/gate.ts`:

```ts
export default {
  name: "gate",
  gates: [{
    name: "tests-after-edit",
    check: (ctx: any) => ctx.changed.length && ctx.testsAfterLastEdit === false
      ? "you changed files but did not run the tests after the last edit" : true,
  }],
};
```

Start `amness` and approve the plugin. If the agent edits files and tries to finish without a test run, it sees `REJECTED by a hook: gate "tests-after-edit" (plugin gate) found problems:`. After 2 rejections for the same task, the run finishes anyway with a warning. Details: [Plugins](plugins.md#add-a-finish-gate). Tested with scripted models only.

## 14. Deny a tool with a policy and test it on past traces

1. Save `.amness/plugins/nocurl.ts`:

   ```ts
   export default {
     name: "nocurl",
     policy: ({ tool, args }: any) =>
       tool === "sh" && /\bcurl\b/.test(String(args.cmd)) ? { action: "deny", reason: "no curl" } : undefined,
   };
   ```

2. Replay your old sessions through it. This calls no model:

   ```bash
   amness plugin policy .amness/traces --plugin .amness/plugins/nocurl.ts
   ```

   You will see a line such as `40 trace file(s): 2 denied, 0 would ask, 0 allowed by the policy, 900 without an opinion`, then the denied calls. Deny beats ask, and ask beats allow. A policy cannot loosen the safety floor. Details: [Plugins](plugins.md#write-policy-as-code).

## 15. Try a loop strategy and measure it

*Calls your model.* Try it in the chat first:

```text
/strategy plan-first
```

Then measure it against the default:

```bash
amness eval --variants full,strategy:plan-first --builtin hard --trials 3 --metrics diff-lines,tool-calls
```

Read the report as in recipe 6. On one run with `gpt-4.1-mini` (6 tasks), `plan-first` and `full` had the same pass rate and the result was inconclusive. See [Evaluating the harness](evaluation.md#loop-strategies-2026-10-30).

## 16. Stop regressions in CI with `--gate`

*Calls your model.* Save a baseline once and commit it:

```bash
amness eval --variants full --builtin hard --trials 3 --yes --out evals/baseline.json
```

In CI, run the same command with a gate:

```bash
amness eval --variants full --builtin hard --trials 3 --yes --gate evals/baseline.json
```

The exit code is 1 when the pass rate dropped by more than 5 points and the drop is clear, or when tokens per solved task grew by more than 25%. Change the limits with `--gate-tol` and `--gate-cost`. A drop that noise could explain is only a warning. See [Custom metrics and the regression gate](evaluation.md#custom-metrics-and-the-regression-gate).

## 17. Make things fail on purpose with a chaos variant

*Calls your model.* Check that the harness recovers when tools or the API fail:

```bash
amness eval --variants full,chaos:tools,chaos:429 --trials 3
```

`chaos:tools` makes about 1 in 4 tool calls fail. `chaos:429` makes about 3 in 10 model calls fail with a rate-limit error. Other kinds are `chaos:args` and `chaos:slow-tools`. A lower pass rate under chaos shows where the harness does not recover. Not measured on a real model yet.

## Related pages

- [Headless and CI](headless.md)
- [Evaluating the harness](evaluation.md)
- [Plugins](plugins.md)
- [Providers and models](providers.md)
- [Budgets and subagents](budgets.md)

## Next steps

- Start with recipe 6 or 7 to measure the harness on your own work.
- Recipes 13 to 17 cover finish gates, policies, strategies, CI gates and chaos.
- Read [Features in depth](features.md) for permissions, sandbox and memory.
- Read [Using the chat](usage.md) for all slash commands.
