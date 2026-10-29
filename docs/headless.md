# Headless and CI

```bash
amness run --verify "npm test" --json "fix the failing test"      # one-shot, no TTY needed
```

| Flag | |
|---|---|
| `--cwd <dir>` | workspace (default `.`) |
| `--verify <cmd>` | must exit 0 before the agent may finish |
| `--check <cmd>` | fast command run after every edit; failures are shown to the agent at once |
| `--trust-project` | run this project's hooks and honour its allow rules (off by default when headless) |
| `--provider`, `--model`, `--base-url`, `--effort`, `--api` | model selection |
| `--yes` | auto-approve risky commands (default: they are denied) |
| `--json` | one JSON event per line on stdout, then a final `{"kind":"result"}` line |
| `--bundle <file>` / `--export <file>` | continue from / write a portable session bundle |
| `--live [port]` | serve the browser live view |
| `--review` | independent reviewer (extra model calls) |
| `--approval-reviewer` | a second model pre-approves clearly safe risky calls (without `--yes`, calls it does not clear are still denied) |
| `--image <file>` | show the model a picture (repeatable, up to 4; vision model needed) |
| `--best-of <n>` | try the task up to n times in separate git worktrees, stopping at the first attempt that passes `--verify` (required); the winner is applied |
| `--parts <file.json>` | run independent parts (`[{"name","task"}]`) concurrently in worktrees, merged one at a time through `--verify` (required) |
| `--trace <file>` | JSONL trace of every loop event (`AMNESS_OTLP` for OpenTelemetry export) |
| `--max-tokens <n>` · `--no-memory` | hard token cap · disable memory |

`amness eval` has its own flags (see [Evaluating the harness](evaluation.md)).

Exit codes: `0` finished, `1` not finished, `2` usage or configuration error.

A `Dockerfile` is included (`docker build -t amness .`, then `docker run -it --rm -v "$PWD":/work -e ANTHROPIC_API_KEY amness`); it has not been built or tested yet.
