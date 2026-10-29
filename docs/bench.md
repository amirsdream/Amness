# Compare coding agents with `amness bench`

`amness bench` runs the same tasks through several coding-agent tools (Amness, Claude Code, Codex, or any command) and grades every result with the same hidden check.

In this page you will learn:

- what a bake-off can and cannot tell you
- how to set it up on Windows and run it
- how to read the result table
- how to add any other tool as a contestant

A *contestant* is one tool in the comparison. A *task* is one job with a start state and a check. A *trial* is one attempt at one task. A *hidden check* is a command or function that decides if the task is solved. The tool never sees it.

## What a bake-off can and cannot tell you

**What it is.** A bake-off starts each tool on each task in a fresh folder. Then the same check grades the folder.

**Why you would use it.** You get a pass rate with a confidence range, tokens, cost and time for each tool, on tasks that you choose.

**What is the same for every contestant:**

- the tasks and the hidden check
- the prompt text (`promptTemplate`)
- the timeout
- a fresh temporary folder with a new git repository for each run

**What is not the same:**

- The model, unless you set one for each contestant. Each tool picks its own default model.
- The tool's own system prompt, tools and permission settings.
- How tokens and cost are reported. See "Read the table" below.

So the result tells you how the tools behave as a whole, with the settings that you used. It does not tell you which tool is "smarter". Different models can cause a difference, not only the tool. The report prints a list of the settings that were used. Publish that list with your numbers.

## Set up on Windows

Do these steps in PowerShell.

1. Install Node.js 22.18 or newer from nodejs.org. Check it:

   ```powershell
   node --version
   ```

2. Install [Git for Windows](https://git-scm.com/download/win). The bench needs `git` on your PATH. The hidden checks of the built-in tasks use bash tools such as `test`. Amness looks for the `bash.exe` that comes with Git (in `Program Files\Git\bin`) and for any `bash.exe` on PATH. It skips `C:\Windows\System32\bash.exe`, because that is the WSL launcher and it sees other files (see `src/shell.ts`).

3. Download Amness and install its packages:

   ```powershell
   git clone https://github.com/amirsdream/Amness.git
   cd Amness
   npm install
   npm link
   amness --version
   ```

4. Install and log in to the other tools yourself. Follow their own documentation. This page does not repeat install commands, because they change.
   - Claude Code: <https://docs.claude.com/en/docs/claude-code>
   - Codex: <https://github.com/openai/codex>

5. Open a new terminal, so that the new PATH is read. Make sure `claude` and `codex` run from any folder. Then check:

   ```powershell
   amness bench --check
   ```

   You see one line per contestant, `found` or `missing`. The exit code is 1 if one is missing. The check calls no model.

6. Set the API keys that you need in the same terminal. For Amness, see [Getting started](getting-started.md). For `claude-bare` you need `ANTHROPIC_API_KEY`.

   ```powershell
   $env:ANTHROPIC_API_KEY = "sk-ant-..."
   ```

**What was tested on Windows.**

- Tested: the bench code and the stdin path (`amness run -`) run in the automated tests on a Windows machine in CI. That CI job is marked informational. It is allowed to fail.
- Not tested: the `claude` and `codex` presets have not been run on any machine by the author. Their flags come from the vendors' documentation and may differ in your version.

**If a flag differs on your version,** run `claude --help` or `codex exec --help`. Then edit `args` for that contestant in `bench.json`. No code change is needed.

On Windows, Amness starts each tool through the shell, so `.cmd` shims work. It quotes the arguments for you. The presets send the prompt on standard input, so the prompt text never needs quoting.

## Run your first bake-off

1. Write a starter config. It has four contestants: `amness`, `amness-gate`, `claude` and `codex`.

   ```bash
   amness bench --init
   ```

   The command writes `bench.json`. It will not overwrite a file that exists.

2. Edit `bench.json`:

   | Setting | Meaning |
   |---|---|
   | `contestants` | The list of tools. Delete the ones that you do not have. |
   | `model` (per contestant) | The model for that tool. Set it for all, in the same family if you can. |
   | `trials` | Attempts per task and contestant (starter file: 3). |
   | `jobs` | Runs at the same time (starter file: 2). Use 1 if you see rate-limit errors. |
   | `timeoutSec` | Seconds before a run is killed (starter file: 900). |
   | `promptTemplate` | The prompt for every tool. `{task}` is the task text. `{verify}` is the check command that the task offers. |
   | `gitInit` | Make a git repository in each folder (default true). |
   | `logDir` | Where the raw output of every run is kept (default `.amness/bench/logs`). |

3. Look at the plan. This runs nothing and costs nothing:

   ```bash
   amness bench --config bench.json --dry-run
   ```

   You see the number of runs, the prompt for the first task, and the exact command line of every contestant. Models you did not set show as "the tool's default". A line `! codex: "codex" is not on PATH` warns you about a missing tool.

4. Run the probe. It gives one tiny real task to each contestant. It confirms that the tool starts, that the grading works, and that tokens and cost are read. It costs a few cents.

   ```bash
   amness bench --config bench.json --probe
   ```

   Read the `PASS` or `FAIL` lines and the notes. Fix problems here, before the big run.

5. Set a spending limit on every account. Then run:

   ```bash
   amness bench --config bench.json --builtin code
   ```

   Amness asks you to confirm the cost. Add `--yes` to skip the question. Amness prints one `PASS` or `FAIL` line for each run while it works. At the end it prints the table and saves the raw results in `.amness/bench/<time>.json`. Use `--out <file>` to choose another file.

### Read the table

Without `--config`, `amness bench --contestants amness,claude --model <name>` uses presets. `--models amness=<a>,claude=<b>` sets one model for each preset.

The first table looks like this. The numbers are an example. They are not a measurement.

```text
13 tasks × 3 trials; intervals are 95% bootstrap over tasks; baseline = amness

variant                pass [95% CI]        pass^3  tok/solved  cache  steps  secs   pareto
amness                 77% [59-92]          62%     41k         58%    9.0    74.2   ●
claude                 82% [64-95]          69%     55k         71%    7.5    61.0
codex                  69% [49-87]          51%     n/a         n/a    0.0    88.5

vs amness (paired by task)
variant                Δ pass [95% CI]          W/L/T     p (Holm)  Δ tok/solved  verdict
claude                 +5 [-10, +21]            3/2/8     0.600     +14k          inconclusive

custom metrics (mean per run; Δ against amness with 95% interval over tasks)
variant                cost-usd                       secs
amness                 n/a                            74.20
claude                 0.31  Δ n/a                    61.00  Δ -13.20 [-30.10, +3.00]
```

| Column | Meaning |
|---|---|
| `pass [95% CI]` | Share of runs that passed, and the range where the true rate probably lies. |
| `pass^3` | Chance that 3 attempts at a task all pass. It is low for a tool that only wins sometimes. |
| `tok/solved` | Tokens used for each solved task. A *token* is a small piece of text that a model reads. It shows `n/a` when the tool does not report tokens. |
| `cache` | Share of input tokens that came from the cache. |
| `steps` | Mean turns per run. It is 0 when the tool does not report turns. |
| `secs` | Mean wall-clock seconds per run. |
| `pareto` | A dot marks a tool that no other tool beats on both pass rate and cost. |
| `Δ pass` | Difference in pass rate against the baseline, paired by task. The baseline is the first contestant. |
| `W/L/T` | Tasks where this tool won, lost or tied against the baseline. |
| `p (Holm)` | The p-value, adjusted because you compare several tools at once. |
| `verdict` | `better`, `worse` or `inconclusive`. |

The `cost-usd` and `secs` metrics are in the custom metrics table. `cost-usd` is the money that the tool reports for a run. `secs` is the run time in seconds, measured by Amness. Only tools that report a cost have `cost-usd`.

**What "inconclusive" means.** The data cannot tell the tools apart. It does not mean that the tools are equal. In the example, the interval for the difference goes from -10 to +21 points. That includes zero.

**Why 13 tasks and 3 trials is a minimum.** The report prints a line like "only pass-rate differences above ~55 points can be detected reliably". It comes from `minDetectable` in `src/stats.ts`. It is a rough rule: 80% power, 5% error, worst-case variance. With 13 tasks, it is about 55 points. With 50 tasks, it is about 28. More trials reduce the noise from model sampling. They do not add tasks. Only more tasks make small differences visible. With fewer than 3 trials, the report warns you.

If a run cannot be set up, it goes to the "exclusion ledger" and is not counted. After the run, read the logs in `logDir` for any surprise.

To read the saved results again:

```bash
amness eval --report .amness/bench/<run>.json
```

## Choose the tasks

| Suite | Command | What is in it |
|---|---|---|
| `code` (default) | `amness bench --builtin code` | 13 easy tasks |
| `hard` | `amness bench --builtin hard` | 6 harder tasks |
| `adversarial` | `amness bench --builtin adversarial` | Tasks that try to trick the tool |
| Your own | `amness bench --cases ./my-tasks` | A folder of `.json` task files |
| Your own, with functions | `amness bench --cases my-tasks.ts` | A `.ts` or `.js` module that exports a list of cases |
| SWE-bench format | see below | A `.jsonl` file |

The built-in suites are small and made by us. They are not a public benchmark. Use `--only a,b` to run only some tasks.

For your own tasks, use the same file format as `amness eval`. See [Evaluating the harness](evaluation.md) for the fields `files`, `task`, `verify` and `check`, and for a function check. Test them first with `amness eval --cases ./my-tasks --selftest`.

For a SWE-bench-format file:

```bash
amness bench --suite instances.jsonl --test-cmd "python -m pytest -x -q {tests}" --install "pip install -e ." --limit 20
```

`--test-cmd` is required with `--suite`. Python and the repositories' needs must be installed on your machine. Not verified on Windows.

## Use a subscription or an API key

| Preset | Login | What it loads | Note |
|---|---|---|---|
| `claude` | Your Claude login | Your own settings, `CLAUDE.md` and hooks | Your configuration mixes into the result. |
| `claude-bare` | `ANTHROPIC_API_KEY` only | Nothing from your user setup | A clean room. The `--bare` flag never reads OAuth or the keychain, so a subscription login does not work. |
| `codex` | Your Codex login | Ignores your user config and rules | Runs in a `workspace-write` sandbox. |
| `amness`, `amness-gate` | Your Amness provider key | Your Amness settings | `amness-gate` also uses `--verify`, so it cannot finish before the check passes. The others only see the check in the prompt. |

Cost and tokens:

- Claude's JSON output includes `total_cost_usd`, so you see `cost-usd` and tokens.
- Codex shows tokens only. The token event format is not documented, so the parser reads what is commonly there. The `--probe` run tells you if it worked. Not verified on a real Codex.
- Amness shows total tokens only (no split of input and output, no cost).
- To get cost for tools without it, multiply the tokens by the price yourself. The bench does not add prices.

## Add any other tool as a contestant

Add an object to `contestants` in `bench.json`:

```json
{
  "name": "my-tool",
  "command": "my-agent",
  "args": ["--headless", "--model", "{model}"],
  "stdin": true,
  "model": "my-model-1",
  "parse": "none",
  "env": { "MY_AGENT_KEY": "..." },
  "timeoutSec": 600,
  "note": "my agent, default settings"
}
```

| Field | Meaning |
|---|---|
| `name` | A unique name. It is the row name in the report. |
| `command` | The program. It is found through PATH. |
| `args` | Arguments. These placeholders are replaced: `{task}` (task text), `{cwd}` (the run folder), `{model}`, `{verify}` (the task's check command). |
| `stdin` | `true` sends the prompt on standard input. This is the best choice, because there is no quoting problem. `false` sends no input. Then put `{task}` in `args`. |
| `model` | The value for `{model}`. Shown in the report. |
| `parse` | How to read tokens and cost: `claude-json`, `codex-jsonl`, `amness-json` or `none`. With `none`, the report has no tokens or cost for this tool. |
| `env` | Extra environment variables for this tool only. |
| `timeoutSec` | A timeout for this tool. The default is the bench timeout. |
| `note` | A text shown in the report. Say what is special, for example "uses my login". |

Names must be different. Every contestant needs a `name` and a `command`. Check the new entry with `--dry-run` and `--probe`.

## Fair-play checklist

- Use the same model family for every tool where you can, and set `model` for each.
- Use the same permission level. The presets allow file edits and shell commands without asking.
- The run order is task by task, then contestant, then trial. A slow period of the API can still affect one tool more than another. Repeat the bake-off on another day.
- Do not run it while the machine is busy. Time is measured in wall-clock seconds.
- `jobs` above 1 runs tools at the same time. Your API rate limits may then cause failures that are not the tool's fault. Use `jobs` 1 for timing.
- Set a spending limit on every account before you start.
- Run it in a VM or container. The tools are not sandboxed from your machine, and they can run commands. This matters most for tasks that you did not write.
- Publish `bench.json` and the raw results file together with your numbers.
- Do not use `claude` for a fair test unless you accept that your own `CLAUDE.md` and hooks are part of it. Use `claude-bare` or say so in the `note`.

## Limits and common problems

| Problem | What to do |
|---|---|
| `missing ... (not on PATH)` | Open a new terminal. Run `where claude` or `where codex` (Windows) or `which claude`. Add the folder to PATH. |
| `could not start <command>: ...` in the note | The program could not run. Run `--check`, and run the command by hand in a terminal. |
| `timed out after Ns` | Raise `timeoutSec` or `--timeout`. A timed-out run counts as a fail. |
| `n/a` in `tok/solved` or `cost-usd` | The tool did not report it, or `parse` is wrong. Run `--probe` and open the `.out.txt` file in `logDir`. |
| Every run of one tool fails with the same note | The flags or the login are wrong. Read the `.err.txt` and `.cmd.json` files in `logDir/<name>/`. Fix `args`. |
| A tool says an option is unknown | Your version differs. Check `--help` of the tool and edit `args`. |
| Quoting problems on Windows | Keep `stdin: true`. Avoid `{task}` in `args`. |
| The check fails on `test` or `bash` not found (Windows) | Install Git for Windows. Make sure its `bin` folder is not blocked, or put a `bash.exe` on PATH. |
| `none of the contestants can start` | No tool was found. Run `--check`. |
| `the tool reported an error but the check passed` | Only a note. The run counts as a pass, because the check decides. |

Other limits: the bench does not stop a tool from reading your files. Tokens and cost depend on what each tool reports. The `claude` and `codex` presets are not verified on a real machine.

## Related pages

- [Evaluating the harness](evaluation.md)
- [Headless and CI](headless.md)
- [Getting started](getting-started.md)

## Next steps

- Read [Evaluating the harness](evaluation.md) to write your own tasks and understand the statistics.
- Read [Plugins](plugins.md) to change Amness before you compare it.
- Read the [Cookbook](cookbook.md) for a short recipe.
