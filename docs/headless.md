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

**Example.** With `--json`, each event is one JSON line, and the last line is the result:

```json
{"kind":"result","finished":true,"text":"...","steps":8,"tokens":15200}
```

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
| `--trust-project` | Runs this project's `.amness/hooks.json` and plugins, and honours its allow rules. They run code, so they are off by default in headless runs. `--trust-hooks` is an older name for the same flag. |
| `--sandbox <mode>` | Runs shell commands under an OS sandbox: `workspace` (write only in the project and temp folders) or `strict` (also no network). The same limits apply as in the chat: **Windows has no OS sandbox**. |
| `--provider`, `--model`, `--base-url`, `--effort`, `--api` | Model selection. `--effort` accepts `none`, `low`, `medium`, `high`, `xhigh` or `max`. `--api` accepts `auto`, `responses` or `chat`. |
| `--yes` | Approves risky commands automatically. The default is to deny them. |
| `--json` | Prints one JSON event per line on stdout, then a final `{"kind":"result"}` line. |
| `--bundle <file>` | Continues from a portable session bundle. You can omit the task. |
| `--export <file>` | Writes a portable session bundle when the run ends. |
| `--live [port]` | Serves the browser live view. The address goes to stderr. |
| `--review` | An independent reviewer writes acceptance criteria and checks the work. It costs extra model calls. |
| `--approval-reviewer` | A second model approves clearly safe risky calls. Without `--yes`, calls that it does not clear are still denied. |
| `--image <file>` | Shows the model a picture. You can repeat it, up to 4 times. Allowed: png, jpg, gif, webp, up to 5 MB each. It needs a vision model. |
| `--best-of <n>` | Tries the task up to n times in separate git worktrees. See below. |
| `--parts <file.json>` | Runs independent parts at the same time. See below. |
| `--trace <file>` | Writes a JSONL trace of every loop event. Set `AMNESS_OTLP=<collector url>` to export with OpenTelemetry. |
| `--max-tokens <n>` | A hard token cap. The default is 300,000 (or the value in your config). |
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
