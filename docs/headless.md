# Headless and CI

*Headless* means that Amness runs one task without a chat window, so you can use it in scripts and in CI (continuous integration, the system that tests your code on each change).

In this page you will learn:

- how to run one task with `amness run`
- how to make the agent prove its work with `--verify`
- how to read the JSON output and the exit codes
- how to run several attempts or several parts at once

## Run one task

**What it is.** `amness run` runs a single task and then exits. It needs no terminal. `amness -p "task"` and `amness --print "task"` do the same.

**Why you would use it.** You can call Amness from a script, a scheduled job or a CI step.

**How to use it.**

1. Set a key for your provider (see [Providers and models](providers.md)).

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

2. Run a task with a check command. The agent cannot finish until the command exits with code 0.

   ```bash
   amness run --verify "npm test" --json "fix the failing test"
   ```

3. Read the result. Without `--json`, the final text of the agent goes to stdout and the progress goes to stderr.

**Example.** With `--json`, each event is one JSON line. The first line says which settings are in effect, and the last line is the result:

```json
{"kind":"config","version":"0.7.3","provider":"custom","model":"qwen-vllm","contextWindow":131072,"maxSteps":40,"maxTime":675,"guardsOff":["pin"],"guardsOn":["coverage","toolcache","..."],"toolChoice":"auto","thinkingBudget":4096,"request":null,"sandbox":null,"plugins":[],"memory":false}
{"kind":"result","finished":true,"text":"...","steps":8,"tokens":15200}
```

The `config` line lets an evaluation record what really ran (the version, the guards on and off, the limits, the profile's values), not only what it asked for. It never contains a key. It also has:

- `roles`: the jobs that run on another model, for example `{"explore":"server:lab/qwen-35b"}`, and `tier` (`local`, `mid` or `frontier`) for the main model.
- `harnessCard`: the same settings sorted into seven layers (`execution`, `tools`, `context`, `scheduling`, `observability`, `verification`, `governance`), with each guard shown as on or off. Report it next to a score: a study found that changing the harness moved results more than changing the model (arXiv 2605.23950).

When a run used more than one model, the `result` line also has `byModel` and `byTier`: calls, tokens and seconds spent waiting, for each model and for each tier.

The values are an example. The field `stopped` is missing when the run ends normally. When the run stops early, it is `budget`, `maxSteps`, `aborted`, `stuck` or `blocked`. If a model call fails, the last line is `{"kind":"error","message":"..."}`.

**Exit codes.**

| Code | Meaning |
|---|---|
| `0` | The agent finished. |
| `1` | The agent did not finish, or an error happened. |
| `2` | Usage or configuration error (for example no task, or no API key). |

**Limits and common problems.**

- If you give no task and no `--bundle`, Amness prints the usage text and exits with 2.
- If there is no API key, Amness says so and exits with 2. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- Without `--verify`, nothing proves the work. The agent only says it is done.

## Flags

| Flag | What it does |
|---|---|
| `--cwd <dir>` | The workspace. The default is `.`. |
| `--verify <cmd>` | A command that must exit 0 before the agent may finish. |
| `--check <cmd>` | A fast command that runs after every edit. The agent sees failures at once. |
| `--mcp-config <file or JSON>`, `--strict-mcp-config`, `--no-mcp` | MCP servers for this run (the `mcpServers` format, repeatable); only those; or none. Your own servers (`amness mcp add`) start by default. See [MCP servers](mcp.md). |
| `--trust-project` | Runs this project's `.amness/hooks.json`, plugins and `.mcp.json` servers, and honours its allow rules. They run code, so they are off by default in headless runs. `--trust-hooks` is an older name for the same flag. |
| `--sandbox <mode>` | Runs shell commands under an OS sandbox: `workspace` (write only in the project and temp folders) or `strict` (also no network). The same limits apply as in the chat: **Windows has no OS sandbox**. |
| `--provider`, `--model`, `--base-url`, `--effort`, `--api` | Model selection. `--effort` accepts `none`, `low`, `medium`, `high`, `xhigh` or `max`. `--api` accepts `auto`, `responses` or `chat`. |
| `--yes` | Approves risky commands automatically. The default is to deny them. |
| `--json` | Prints one JSON event per line on stdout, then a final `{"kind":"result"}` line. |
| `--bundle <file>` | Continues from a portable session bundle. You can omit the task. |
| `--export <file>` | Writes a portable session bundle when the run ends. |
| `--live [port]` | Serves the browser live view. The address goes to stderr. |
| `--review` | An independent reviewer writes acceptance criteria and checks the work. It costs extra model calls. |
| `--approval-reviewer` | A second model approves clearly safe risky calls. Without `--yes`, calls that it does not clear are still denied. |
| `--explore-model`, `--compact-model`, `--review-model`, `--cheap-model`, `--approve-model`, `--quarantine-model` `<model>` | A model for one job, for this run. The model is an id on the main provider, `provider:model` (for example `anthropic:claude-haiku-5-5`), or a saved server (`server:lab`, `server:lab/<model>`). The default comes from `models` in your config. See [Models per job](features.md#models-per-job-and-a-fallback). |
| `--fallback <model>` | Answers from this model when the main one is overloaded or not reachable. |
| `--router` | Sends exploration steps to the `--cheap-model` when that saves money. |
| `--subagents` | Offers the `task` tool (the explorer and your custom subagents). It is on by itself when a model for `explore` is set. |
| `--image <file>` | Shows the model a picture. You can repeat it, up to 4 times. Allowed: png, jpg, gif, webp, up to 5 MB each. It needs a vision model. |
| `--best-of <n>` | Tries the task up to n times in separate git worktrees. See below. |
| `--best-of-all` | With `--best-of`: run all n attempts, then pick among the passing ones with a tournament. |
| `--parts <file.json>` | Runs independent parts at the same time. See below. |
| `--trace <file>` | Writes a JSONL trace of every loop event. Set `AMNESS_OTLP=<collector url>` to export with OpenTelemetry. |
| `--max-tokens <n>` | A hard token cap. The default is 300,000 (or the value in your config). |
| `--local-weight <0-1>` | How much a token of a local-tier model counts against `--max-tokens`. The default is 1. |
| `--advisor-model <model>` | A stronger model the agent consults at a few moments. See [Ask a stronger model](features.md#models-per-job-and-a-fallback). |
| `--ladder <model,model,…>`, `--ladder-start <n>` | Runs the loop on a recovery ladder of models, cheapest first. |
| `--explore-ranges` | The explorer answers with file ranges that are checked against the files. |
| `--background` | Starts the run and returns at once. It goes on in its own git worktree (`--here`: in this folder), logs to `.amness/background/<id>.jsonl`, and sends a system notification at the end. Follow it with `amness tasks`, `amness tasks <id>`, `--apply <id>`, `--drop <id>`, `--stop <id>`. |
| `--stable-tools` | Keeps the tool list the same for the whole run, so the prompt cache survives. |
| `--tool-choice`, `--thinking-budget`, `--keep-thinking`, `--request`, `--off`, `--plugin`, `--max-time`, `--max-steps`, `--context-window` | See `amness run --help`. |
| `--no-memory` | Turns memory off. |

`amness eval` has its own flags. See [Evaluating the harness](evaluation.md).

## Make a run safe in CI

**Why you would use it.** In CI nobody can answer a question, so Amness must decide alone.

**How it behaves.**

1. Risky commands are **denied** by default. The agent gets the message "non-interactive run: risky commands are denied unless --yes is passed".
2. Project hooks, plugins and allow rules are **ignored** unless you pass `--trust-project`. Amness prints a note when it ignores them.
3. Pass `--yes` only in a container or a throwaway checkout with your work committed. The shell is not sandboxed unless you add `--sandbox workspace` or `--sandbox strict`.

**Example.**

```bash
amness run --sandbox workspace --verify "npm test" "make the date parser handle leap days"
```

**Limits and common problems.**

- `--yes` approves risky commands. The safety floor still applies (for example, no force-push to main). See [Safety and privacy](safety.md).
- The run ends with exit code 1 when the token cap is reached. The last text then starts with `stopped:`. Raise `--max-tokens` or give a smaller task. See [Budgets and subagents](budgets.md).

## Try the task several times with `--best-of`

**What it is.** Amness tries the task up to n times, each in its own git worktree (a separate copy of your repository). It stops at the first attempt that passes `--verify`, and it applies that result.

**Why you would use it.** One attempt can fail by chance, and a second attempt may pass.

**How to use it.**

```bash
amness run --best-of 3 --verify "npm test" "make the flaky test deterministic"
```

You see one line on stderr for each attempt, for example `attempt 1: failed verify (41200 tokens)`. At the end Amness says which attempt won, or that no attempt passed.

**Each retry learns from the failed attempts.** An attempt after a failure gets, below the task, a short summary of each earlier attempt: the files it changed, what it said, and the end of the verify output. It is told not to repeat what did not work. The summary is built from the attempt's own record, without an extra model call.

**Run all attempts and pick the best.** Add `--best-of-all` to run all n attempts at the same time instead of stopping at the first pass. If several pass, Amness compares them in groups of three: one short model call per group reads each attempt's summary and diff and picks the one that does the task most completely, in the real code. Group winners then meet again until one is left (a tournament). This costs n attempts every time. A plugin can replace the comparison with its own `select` function.

Why: in "Scaling Test-Time Compute for Agentic Coding" (arXiv 2604.16529), summaries of earlier attempts, tournament selection and retries conditioned on distilled summaries raised SWE-bench Verified from 70.9% to 77.6%. Not measured in Amness yet.

**Limits and common problems.**

- `--verify` is required, and so is a git repository with at least one commit. Otherwise Amness exits with 2.
- Each attempt gets the token cap divided by n.
- Exit code is 0 only if an attempt won and Amness applied it.
- It is implemented and unit-tested. It is **not shown yet to help on real work**.

## Run independent parts with `--parts`

**What it is.** You give a JSON file with a list of tasks. Amness runs them at the same time in worktrees and merges them one at a time. Each merge must pass `--verify`.

**How to use it.**

1. Write the file.

   ```json
   [
     {"name": "docs", "task": "update the README install section"},
     {"name": "tests", "task": "add a test for the date parser"}
   ]
   ```

2. Run it.

   ```bash
   amness run --parts parts.json --verify "npm test"
   ```

**Limits and common problems.**

- Amness reports conflicts and does not apply them.
- The exit code is 0 only when every part is `merged`.
- The same requirements as `--best-of` apply (`--verify`, a git repository). It is **not shown yet to help on real work**.

## Continue a run elsewhere

**How to use it.**

1. Write a bundle at the end of a run.

   ```bash
   amness run --export bundle.json "start the refactor"
   ```

2. Continue on any machine or model.

   ```bash
   amness run --bundle bundle.json "continue"
   ```

## Docker and GitHub Actions

- A `Dockerfile` is included: `docker build -t amness .`, then `docker run -it --rm -v "$PWD":/work -e ANTHROPIC_API_KEY amness`. CI builds the image and runs `--version` and a self-test in it (see [Development](development.md)).
- **Keys in Docker.** Inside a container Amness never saves a key to disk. Pass it in one of two ways:
  - an environment variable: `-e ANTHROPIC_API_KEY` (with no value, Docker copies it from your shell, so it is not typed on the command line);
  - a Docker secret, which is mounted as a file: `-e ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic`. `OPENAI_API_KEY_FILE` and `TAVILY_API_KEY_FILE` work the same way.

  The image sets `AMNESS_KEYSTORE=none`. Amness also detects `/.dockerenv` and Kubernetes on its own. If you type a key into the chat in a container, it is used for that session only.
- The repository has a GitHub Action in `action.yml`. Its inputs are `task`, `verify`, `provider`, `model`, `max-tokens` and `comment`. See [Features: Scheduled runs and the GitHub Action](features.md#scheduled-runs-and-the-github-action).

## Related pages

- [Using the chat](usage.md)
- [Providers and models](providers.md)
- [Safety and privacy](safety.md)
- [Evaluating the harness](evaluation.md)

## Next steps

- [Getting started](getting-started.md)
- [Budgets and subagents](budgets.md)
- [Features in depth](features.md)
