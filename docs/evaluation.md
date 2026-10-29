# Evaluating the harness

`amness eval` runs the coding agent on a set of tasks, with and without each safety feature, and tells you in numbers whether a change helped.

In this page you will learn:

- what an eval is, and why it needs many tasks and several trials
- how to run the built-in task suites and read the report
- how to write your own tasks and compare your own harness variants
- what has been measured so far, and what has not

## What an eval is

An *eval* is a test for the agent. You give the agent a task in a fresh folder. When the agent stops, a separate check decides if the task is solved. The check is a shell command (exit code 0 means pass) or a function. The agent never sees the check. We call it the *held-out check*.

A *variant* is one way to set up the harness. For example, `baseline` has no guards and `full` has all guards. A *guard* is a rule in the agent loop that stops a known mistake, such as repeating the same call.

Each task runs in a new temporary workspace. The agent sees the task and an optional `verify` command. This is a command the agent may run to check its own work.

## Why one run is not enough

A model gives different answers each time. One pass or one fail tells you almost nothing. So Amness repeats each task (a *trial*) and uses many tasks.

- Trials of the same task are linked, because they share the same hard parts. So Amness treats the **task** as the unit. The intervals are resampled over tasks, and comparisons are paired by task.
- With few tasks, only large differences can be seen. The report prints this limit at the bottom. With 13 tasks, only differences above about 55 points can be detected.

## Run your first eval

1. Check that every built-in task can be solved. This calls no model and costs nothing.

   ```bash
   amness eval --selftest
   ```

2. Compare the agent with no guards (`baseline`) and the full harness (`full`) on the 13 built-in tasks. This calls your model and costs tokens. The command shows a plan and asks before it starts.

   ```bash
   amness eval --variants ab --trials 3
   ```

3. Read the report. Amness also saves the raw results in `.amness/evals/<time>.json`.

4. To read a saved result again without running anything:

   ```bash
   amness eval --report .amness/evals/<run>.json
   ```

   Replace `<run>` with the file name that the command printed.

Expected output of step 1 (the first lines):

```
ok  off-by-one
ok  missing-feature
ok  rename-across-files
```

Every line must start with `ok`. A line that starts with `bad` shows a task with a problem, and the reason follows. A line with the reason `unverified` means the task has no reference solution.

Use `--yes` to skip the cost question, for example in a script.

## Read the report

The report has a table with one row per variant.

| Column | What it means |
|---|---|
| `pass [95% CI]` | Share of tasks solved. The brackets show the 95% *confidence interval* (CI): the range in which the true value probably lies. It is a bootstrap over tasks. |
| `pass^k` | The chance that k attempts at a task all pass (k is 3, or the number of trials if smaller). It is low for a variant that only succeeds sometimes. |
| `tok/solved` | Tokens used per solved task, not per run. A *token* is a small piece of text that a model reads. A variant that gives up early looks cheap per run, but it is not efficient. |
| `cache` | Share of prompt tokens that the provider served from its cache. It shows `-` if the provider reports none. |
| `steps`, `secs` | Average steps and seconds per run. |
| `pareto` | A dot marks a variant that no other variant beats on both pass rate and tokens per solved task. |

Under the table, Amness compares each variant with the baseline (the first variant, or the one you name with `--baseline`).

| Column | What it means |
|---|---|
| `Δ pass [95% CI]` | Change in pass rate, in points, with its interval. |
| `W/L/T` | Tasks where the variant won, lost or tied. |
| `p (Holm)` | The p-value of an exact sign test on the tasks where the two variants differ. Amness corrects it for the number of variants (Holm correction). |
| `Δ tok/solved` | Change in tokens per solved task. |
| `verdict` | `better`, `worse` or `inconclusive`. |

After that, "guards fired per run" shows how often each guard acted (for example nudges, loop blocks, rejected finishes and trimmed output). It helps you see why a variant behaves as it does.

### How to read "inconclusive"

The verdict is `better` only if the whole interval is above zero and the adjusted p-value is below 0.05. It is `worse` in the mirror case. In all other cases it is `inconclusive`.

`inconclusive` means the data cannot tell. It does **not** mean the variants are equal. Add more tasks or trials before you decide.

## Choose a task suite

`--builtin` selects the suite. The suites are small and made by us, so they test the guards. They do not replace a public benchmark.

| Suite | Command | What it has |
|---|---|---|
| `code` (default) | `amness eval --builtin code` | 13 easy tasks, such as an off-by-one bug, a rename across files and a test-weakening trap. |
| `hard` | `amness eval --builtin hard` | 6 tasks with hidden edge cases, a misleading symptom, a question to answer from a 50-file repository, a string-dispatch rename, an async-ordering bug and a slow function. |
| `adversarial` | `amness eval --builtin adversarial` | 3 prompt-injection tasks. A run passes only if the harmless job is done and the injected command never ran. |

Use `--only a,b` to run only some tasks by name.

## Compare variants

Variants are chosen with `--variants`. You can give a preset or a comma list.

| Preset | Variants |
|---|---|
| `ab` (default) | `baseline`, `full` |
| `ablate` | `full`, then `full` with each guard or feature removed in turn |
| `all` | `baseline`, `no-gate`, `full`, `full+check`, `full+review`, and every `full-<guard>` |

Single variants:

- `baseline`: no guards and no verify gate.
- `full`: all guards and the verify gate.
- `full+check`: adds a post-edit check.
- `full+review`: adds the independent reviewer (extra model calls).
- `full+route`: exploration on a cheaper model. It needs `--cheap-model <id>`.
- `full+plugins`: every plugin from `--plugin` is active. See [Plugins](plugins.md).
- `no-gate`: guards, but no verify gate.
- `full-<guard>`: `full` with one guard or feature off. The names are `nudge`, `loop`, `compact`, `stuck`, `wrapup`, `condense`, `schedule`, `ledger`, `stagnation`, `index` and `taint`.

### Ablations

An *ablation* switches one part off and measures what changes. Run this to remove each guard in turn:

```bash
amness eval --variants ablate --trials 5
```

This is a large run. `ablate` has 12 variants, so 13 tasks × 12 variants × 5 trials is 780 sessions. Check the plan line before you accept.

Measure the prompt-injection check:

```bash
amness eval --builtin adversarial --variants full,full-taint
```

### Save a profile after an ablation

Add `--profile-out` to write the guards that the data says to switch off:

```bash
amness eval --variants ablate --trials 5 --profile-out profile.json --profile-model "gpt-*"
```

Amness prints a verdict for each guard (`remove`, `KEEP` or `keep?`) and writes `profile.json`. The command tells you to copy the file to `.amness/profile.json`. `--profile-model` is the model name or pattern that the profile applies to. The default is the configured model.

A profile based on a small suite is weak evidence. Amness prints a note about the strength of the data below the verdicts. Read it.

## Run your own tasks

Your own tasks are the best test, because they match your code.

### As JSON files

1. Make a folder, for example `my-tasks`.
2. Put one `.json` file in it for each task:

   ```json
   {
     "name": "fix-add",
     "files": {
       "add.js": "exports.add = (a, b) => a - b;\n",
       "test.js": "const { add } = require('./add');\nif (add(2, 3) !== 5) { console.error('wrong'); process.exit(1); }\n"
     },
     "task": "The add function is wrong. Fix it.",
     "verify": "node test.js",
     "check": "node test.js",
     "solution": { "add.js": "exports.add = (a, b) => a + b;\n" }
   }
   ```

   - `files` maps a path to its text. Amness writes these files into a fresh folder.
   - `task` is what the agent reads.
   - `verify` is optional. The agent may run it.
   - `check` is the held-out command. Exit code 0 means pass.
   - `solution` is optional. Without it, `--selftest` can only check that the check fails at the start.
   - `name` is optional. The file name is the default.

3. Check the tasks, then run them:

   ```bash
   amness eval --cases ./my-tasks --selftest
   amness eval --cases ./my-tasks --variants ab --trials 3 --jobs 3
   ```

   `--jobs 3` runs three sessions at once.

In the example above, `verify` and `check` are the same command. A good held-out check tests more than `verify` does. Otherwise the agent can pass by tuning only for the command it can see.

### As a `.ts` module

A module can use a function as the check. Export a list of cases:

```ts
// my-tasks.ts
export default [
  {
    name: "write-file",
    files: {},
    task: "Create out.txt containing hi.",
    check: async (dir: string) =>
      (await import("node:fs")).readFileSync(dir + "/out.txt", "utf8") === "hi" || "wrong content",
  },
];
```

```bash
amness eval --cases my-tasks.ts
```

The function gets the workspace folder. It returns `true` for a pass, or a string that explains the failure. Each case needs `name`, `files`, `task` and `check`. See [Plugins](plugins.md) for more on function checks.

### Turn a real failure into a task

If the agent failed in your project, you can keep that failure as a test.

```bash
amness traces --case my-bug --task "Fix the date parsing bug" --check "npm test"
```

This copies the tracked files at git `HEAD` into `.amness/evals/cases/my-bug.json`. The `--check` command must exit 0 only when the task is really done. In the chat, `/report case my-bug` does the same for your last request. Run the result with:

```bash
amness eval --cases .amness/evals/cases --variants ab --trials 3
```

Files over 150 KB, binary files and lock files are left out, and the total is limited to about 1 MB. Add a `"solution"` to the JSON if you want `--selftest` to cover it.

## Use a public benchmark (SWE-bench format)

You can load a file in the format of SWE-bench. Each line of the `.jsonl` file is one instance. Amness reads the fields `instance_id`, `repo`, `base_commit`, `problem_statement`, `test_patch`, `FAIL_TO_PASS` and `PASS_TO_PASS`.

```bash
amness eval --suite instances.jsonl --test-cmd "python -m pytest -x -q {tests}" --install "pip install -e ." --limit 20
```

For each instance, Amness clones the repository at the base commit and runs `--install` once. The agent works. Then Amness applies the hidden tests and runs your `--test-cmd`. The text `{tests}` is replaced by the `FAIL_TO_PASS` test ids.

- An instance that cannot be prepared is **excluded**. The report lists it in an exclusion ledger. It is never counted as a failure.
- `--limit <n>` uses only the first n instances.
- `--seed <n>` makes the bootstrap intervals the same on every run.
- `--trials <n>` runs independent attempts.

### Check a suite for contamination

```bash
amness eval --suite instances.jsonl --audit
```

`--audit` calls no model. It reports instances where the fix lines appear in the problem statement, where the fix is already in the base checkout, or where the base commit is missing. It prints `leak <id>: <problem>` for each problem. The exit code is 1 if it finds any.

### Limits for benchmarks

Most public benchmarks need a separate environment for each instance, often a Docker image. You must provide it through `--install` or a prepared image. Amness gives you the harness and the statistics. It has **not been run against a full public benchmark yet**.

## Limits and common problems

- A real run costs real tokens. The command prints the worst case and asks first. Use `--max-tokens` and `--max-steps` (default 30) to limit each session.
- The built-in suites are small and made by us. They are a regression test for the guards, not proof of quality.
- `full+route` needs `--cheap-model`. A variant name that Amness does not know stops with an error that lists the known names.
- `--variants` and `--baseline`: if the baseline name is not among the variants, Amness uses the first variant.
- The method follows recent practice: harness choice can change cost per solved task by large factors while pass-rate differences stay small ([The Scaffold Effect in Coding Agents](https://arxiv.org/abs/2607.22585)), and task-level paired bootstrap intervals are the right uncertainty statement ([Harness or Model?](https://arxiv.org/html/2609.11987v1)).

## More variant kinds

Besides `baseline`, `full` and the `full-<guard>` names, `--variants` accepts these kinds. All of them run the full harness with one change. They are **tested** with scripted models (`test/trackc.test.ts`). Only `strategy:` was run on a real model (see below).

| Variant | What it does |
|---|---|
| `prompt:<id>` | Replaces the system prompt with the text of `.amness/prompts/<id>.md`, or `~/.amness/prompts/<id>.md`. The id `base` keeps the built-in prompt. A block of front matter between `---` lines at the top of the file is removed. |
| `model:<id>` | Runs the full harness on another model. It needs a model by id, which `amness eval` provides. |
| `chaos:tools` | About 1 in 4 tool calls fails with `ERROR: simulated failure`. The `finish` tool is never changed. |
| `chaos:429` | About 3 in 10 model calls fail with a rate-limit error (HTTP 429). Amness retries them. |
| `chaos:args` | About 3 in 10 tool calls from the model arrive with broken JSON arguments. |
| `chaos:slow-tools` | Every tool call waits 400 ms first. |
| `strategy:<name>` | The full harness with a loop strategy: `plan-first` or `explore-then-act`. See [Plugins](plugins.md#change-the-loop-with-a-strategy). |
| `full+plugins` | The full harness with every plugin from `--plugin` active. |

Prompt ids may use letters, numbers, `.`, `_` and `-`, up to 40 characters. A project prompt wins over a user prompt with the same id. An unknown id stops the run and lists the ids found.

Example. Compare a short prompt with the built-in one:

```bash
mkdir -p .amness/prompts
echo "You are a careful coding agent. Make the smallest change that works." > .amness/prompts/terse.md
amness eval --variants full,prompt:terse --trials 3
```

Limits: chaos failures are random but use a fixed seed, so a run is repeatable only in its pattern, not in what the model does. A chaos variant tells you whether the harness recovers. It does not tell you how often real tools fail.

## Custom metrics and the regression gate

**What it is.** A *metric* is a number that Amness records for every run, next to pass or fail. The report shows its mean for each variant and the paired difference to the baseline. A *regression gate* compares a new run with a saved one and exits with code 1 when things got clearly worse.

**Why.** Pass rate alone hides a lot. Two variants can pass the same tasks while one changes twice as many lines. The gate lets CI catch a drop in quality or a rise in cost.

**How to use it.**

1. Choose metrics with `--metrics`:

   ```bash
   amness eval --variants full,strategy:plan-first --builtin hard --trials 3 --metrics diff-lines,tool-calls
   ```

   Built-in metrics:

   | Metric | What it counts |
   |---|---|
   | `diff-lines` | Lines added or removed, compared with the task's starting files. A smaller change that still passes is usually better. |
   | `tool-calls` | Tool calls the agent made. |
   | `tokens-per-step` | Tokens spent per step. |
   | `overclaim` | 1 when the agent's text says tests or the build passed but the task check failed. This is a text match, so it is a rough signal. |

   A plugin can add more in its `metrics` field. Metrics from a loaded plugin are always recorded. An unknown name stops the run and lists the known names.

2. Read the extra table in the report. It looks like this (the numbers are made up for the layout):

   ```text
   custom metrics (mean per run; Δ against full with 95% interval over tasks)
   variant                diff-lines                     tool-calls
   full                   22.00                          11.50
   strategy:plan-first    15.30  Δ -6.70 [-14.20, -0.80] 8.60  Δ -2.90 [-6.60, 0.40]
   ```

   The mean is taken per task first, then over tasks. The difference is paired by task. The interval is a 95% bootstrap interval over tasks. If the interval includes zero, the data cannot tell.

3. Save a good run as your baseline. Every run saves its rows to a file:

   ```bash
   amness eval --variants full --builtin hard --trials 3 --out evals/baseline.json
   ```

4. In CI, run again and compare:

   ```bash
   amness eval --variants full --builtin hard --trials 3 --yes --gate evals/baseline.json
   ```

   The command prints a block called `regression gate`. It exits with 0 when every variant is `ok`, and with 1 when one `FAIL`s.

**The rules** (from `gateCompare` in `src/evals.ts`). The gate compares each variant with the same variant in the saved file. It uses only tasks that are in both files.

- **Pass rate.** It fails only when the drop is bigger than `--gate-tol` points (default 5) and the drop is clear. Clear means that the whole 95% interval over tasks is below zero. A drop above the tolerance that noise could explain gives only a `warning`.
- **Cost.** It fails when tokens per solved task grew by more than `--gate-cost` percent (default 25).
- A variant that is not in the saved file passes with the note `not in the baseline file: nothing to compare`.

Example with looser limits:

```bash
amness eval --variants full --yes --gate evals/baseline.json --gate-tol 10 --gate-cost 40
```

**Limits.**

- With few tasks, a real drop is often not "clear", so the gate only warns. The built-in hard suite has 6 tasks. Use more tasks, or more trials, for a gate you trust.
- Model sampling noise can move the cost figure. Use `--trials 3` or more.
- The gate and the metrics are **tested** with scripted data. They have not been run in a real CI pipeline.

## Grade real sessions

**What it is.** An eval runs tasks that you wrote. `amness plugin grade` scores sessions that really happened, from the traces in `.amness/traces`. It makes no model call.

**Why.** It shows how the harness does on the work you actually give it.

**How to use it.**

```bash
amness plugin grade .amness/traces
```

Without a path, Amness reads `.amness/traces`. You can give trace files or folders. Choose graders with `--grader a,b`. Add graders from a plugin with `--plugin <file>`.

Built-in graders (in `src/grade.ts`):

| Grader | Score 1 means |
|---|---|
| `finished` | The agent called the `finish` tool. |
| `no-rejections` | No finish attempt was rejected. |
| `tool-errors` | The share of tool calls that did not fail. |
| `no-loops` | The loop detector never fired. |
| `verified-edits` | Either no file changed, or a test, build or lint command ran and did not fail. |

You will see one line per grader, such as `finished  mean 62%  over 8 session(s)`, and up to five of the lowest sessions with the task text.

**Limits.**

- `finished` means the `finish` tool was called. A plain chat answer does not call it, so it scores 0 there. Do not use `finished` to judge chat sessions.
- `verified-edits` looks for words such as `test`, `build` and `lint` in a shell command. It does not check that the command was the right one.
- A grader that throws is skipped for that session. Sessions with no tool calls and no steps are left out.
- **Tested** with scripted traces. Not measured on a large set of real sessions.

## Measured results so far

Real runs, one model (`gpt-6-luna` through the OpenAI API), 2026-10-29. These are small and say little about harder tasks or other models.

| Run | Result |
|---|---|
| 13 built-in tasks × 2 trials: `baseline`, `full`, `full+review` | Pass rates 96%, 100%, 100%. Tokens per solved task: 9.2k, 8.3k, 14.7k. No pairwise difference is statistically detectable (13 tasks can only detect differences above ~55 points). `full` was cheaper than `baseline` (-971 tokens per solved task) with the same pass rate; `full+review` cost about 77% more tokens per solved task than `full` and about 2.4× the time, with no gain on these tasks. |
| Adversarial suite (3 prompt-injection tasks × 3 trials): `full`, `full-taint`, `baseline` | 100% for all three: this model did not follow the injected commands even without the taint check, so the check had nothing to catch. It remains untested whether it helps with models that are more easily led. |

What this means: the built-in tasks are too easy for this model to separate the variants, and the reviewer is not worth its cost on them. The `full+route`, ablation, `tune` and best-of-n features are not measured. Harder tasks (for example a SWE-bench-format suite with `--suite`) are needed before any guard can be shown to help or hurt. Raw results were saved under `.amness/evals/` (not committed).

### Second round (2026-10-30): a harder suite and weaker models

`amness eval --builtin hard` has 6 tasks with hidden edge cases, a misleading symptom, a question to answer from a 50-file repository, a string-dispatch rename, an async-ordering bug and a slow function. All six have a reference solution checked by `--selftest`.

| Run | Result |
|---|---|
| `gpt-6-luna`, hard suite × 3 trials: `baseline`, `full`, `full+review` | 100% for all three. Tokens per solved task 9.7k / 11.7k / 20.5k: on a model this strong the guards cost 20% more tokens and the reviewer more than double, for no gain. |
| `gpt-4.1-mini`, hard suite × 3 trials, same three variants | 89% / 83% / 89%; the one task all variants miss (`spec-in-docs`: hidden edge cases listed only in a spec file) is missed by every variant, including the reviewer. Tokens per solved task 15.2k / 14.7k / 26.3k. No difference is detectable (6 tasks). |
| `gpt-4.1-mini`, hard suite × 2 trials, `full` against each `full-<guard>` (144 sessions) | Every comparison is inconclusive (pass-rate changes between -17 and +8 points, intervals include zero); removing `taint`, `condense`, `ledger` or `stagnation` was not worse and used fewer tokens, but 6 tasks × 2 trials cannot support removing anything. |
| Injection suite, `gpt-4o-mini`, 6 trials: `full`, `full-taint`, `baseline` | 100% for all: the model did not follow the injected commands even without the taint check. |
| Budget fix, `gpt-4.1-mini`, exploration question, cap 2,500 tokens, 8 runs | Without the final report 7 of 8 runs ended with a bare "token budget exhausted" and nothing else; with it all 8 ended with a short report of what was found and what was left (it named the right file in most), but none completed the answer (the cap was smaller than one full exploration). At caps where the task fits (6,000) both behave the same (8 of 8 answered). At 4,000, 7 of 8 answered without the report and 6 of 8 with it: wrapping up early costs a little completion when the cap is very tight (small sample). |

What this says: the guards neither help nor hurt measurably on these tasks and models; the cost overhead is real and shows even on strong models; the injection suite is too easy; and `spec-in-docs` shows a gap worth fixing (neither the reviewer nor any guard makes the model re-read the spec). `gpt-4.1-nano` and `gpt-3.5-turbo` returned HTTP 404 on this account, so they were not tested.

### Loop strategies (2026-10-30)

Model `gpt-4.1-mini`, `--builtin hard` (6 tasks), 2 trials per task, so 12 sessions per variant. Strategies are described in [Plugins](plugins.md#change-the-loop-with-a-strategy).

| Run | Result |
|---|---|
| `full` against `strategy:explore-then-act` | `full` 92% pass, 14.4k tokens per solved task. `explore-then-act` 83% pass, 24.2k. No detectable difference. |
| `strategy:plan-first`, first version | 17% pass. A bug: a reply with only a plan text ended the run, because the loop treated it as the final answer. It is fixed with the `then` field. This result does not describe the strategy. |
| `full` against `strategy:plan-first`, after the fix, with `--metrics diff-lines,tool-calls` | `full` 83% pass, 35.8k tokens per solved task, 11.9 steps. `plan-first` 83% pass, 20.4k tokens per solved task, 9.0 steps. Pass rate: inconclusive (+0 points, interval -33 to +42). `diff-lines`: 22.0 for `full`, 15.3 for `plan-first` (difference -6.7, interval -14.2 to -0.8). `tool-calls`: 11.5 against 8.6 (difference -2.9, interval -6.6 to +0.4). |

What this says. This is one run with 12 sessions per variant. The token figure for `full` is high because of a few long runs, so the cost difference is not reliable. The smaller diff for `plan-first` is the only interval that excludes zero. This does not show that `plan-first` is better. The pass rate of `full` also changed between the two runs (92% and 83%), which shows how much the numbers move from run to run.

## Related pages

- [Plugins](plugins.md): write eval tasks, variants, metrics, graders and strategies as code.
- [Cookbook](cookbook.md): short recipes, including comparing two variants.
- [Budgets and subagents](budgets.md): why the final report exists.
- [Features in depth](features.md): guards, replay and failure mining.

## Next steps

- Run `amness eval --selftest`, then a small `--variants ab` run on your own tasks.
- Read [Plugins](plugins.md) to compare your own harness against `full`.
- Try the recipes in the [Cookbook](cookbook.md).
