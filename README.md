# Amness

**An advanced, hackable harness for coding agents.** Any model, your own keys, and every part of the loop (guardrails, budgets, tools, prompts, evals) is something you can see, change and measure.

[![CI](https://github.com/amirsdream/Amness/actions/workflows/ci.yml/badge.svg)](https://github.com/amirsdream/Amness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933)
![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

<p align="center"><img src="docs/images/chat.png" alt="Amness full-screen interface: cards, diff, sidebar, input panel" width="900"></p>

> **Who is this for?** Power users who outgrow closed tools: people who want to choose the model, read the loop, write their own guardrails, and *test* whether a change to the harness actually helps. If you want something that works with zero setup, Claude Code and Codex are excellent and you should use them. Amness is for when you want to open the hood. Newer features here are tested but not yet proven on real tasks; see [Status](#status-what-is-and-is-not-proven).

## Quick start

You need **Node 22.18+**, git, and an API key (OpenAI or Anthropic) or a local model server.

```bash
git clone https://github.com/amirsdream/Amness.git && cd Amness && npm install
export OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY=sk-ant-...
npm link                              # gives you the `amness` command
cd ~/your-project && amness           # start a conversation in your project
```

More ways to start:

```bash
amness "fix the failing test"                                  # start with a prompt
amness -c                                                      # continue the last conversation here
amness run --provider ollama --model qwen2.5-coder:7b "list the TODO comments"   # a local model, no key needed (in the chat, use /provider and /model)
amness demo                                                    # a scripted tour of the guardrails, no key needed
```

New to it? Follow the [step-by-step guide](docs/getting-started.md). Inside the chat: `/help` lists everything · `Shift+Tab` changes how much it may do without asking · `Ctrl+P` opens the command palette · `@file` attaches a file or image · `!cmd` runs a shell command · `#note` saves a memory.

## What it looks like

<p align="center"><img src="docs/images/approval.png" alt="An edit waiting for your approval, with the diff" width="780"></p>

This is the screen you will see most. The agent wants to change a file, shows you the exact diff, and waits. More screenshots (subagents, the loop view, themes) are in the [step-by-step guide](docs/getting-started.md).

## Examples

Each example says what you type, what happens, and why it is useful.

### 1. Your first change, in the chat

```bash
cd ~/your-project
amness
```

Then type a request in plain words:

```
❯ The login form accepts an empty password. Fix it and add a test.
```

**What happens.** The agent reads the relevant files, then proposes a change. For each edit it shows you the diff and asks: apply it? Press Enter to accept. When it is done, it tells you what it changed and what it ran to check.

**Why it is useful.** Nothing changes without your approval (in the default mode). If you do not like the result, type `/undo`. It puts back the files and the conversation as they were before that request, including files that shell commands changed.

**Tip.** `Shift+Tab` changes how much the agent may do without asking: ask for everything, auto-accept edits, or plan only (read-only). `/mode yolo` skips most questions, but a safety floor still blocks things like `rm -rf /`.

### 2. Make the agent prove its work

Without a check, an agent can say "fixed!" and be wrong. Give it a command that decides:

```bash
amness run --verify "npm test" "the date parser fails on leap days, fix it"
```

- `--verify "npm test"` is the **proof command**. The agent may not finish until this command succeeds. Use your own test command here (`pytest -q`, `go test ./...`, `cargo test`, ...).
- The last text is the **task**.

**What happens.** The agent works, then tries to finish. Amness runs `npm test`. If it fails, the finish is rejected and the agent must keep going. Amness also compares the agent's summary with what really happened. If the summary says "all tests pass" but no test ran after the last edit, it is rejected too.

**Why it is useful.** You can run this in CI or a script and trust the exit code: `0` means finished and verified, `1` means not finished. In the chat, `/verify npm test` does the same.

### 3. Keep the cost under control

Long tasks can use a lot of tokens (the pieces of text you pay for). Amness lets you set a limit and tells the model about it:

```
/budget 200k
```

**What happens.** The limit applies to each request you send. At 50%, 75% and 90% of it, the model is told to start wrapping up. Just before the limit, Amness asks for one last short report, so you get what was found instead of a bare "budget exhausted" error. The sidebar shows the percentage used.

**Why it is useful.** Exploring a big codebase with subagents can burn tokens fast. The limit and the notes keep a long run from ending with nothing. See [Budgets](docs/budgets.md).

### 4. Use a local model (no API key)

```bash
ollama pull qwen2.5-coder:7b          # download a model that can call tools
amness                                # start the chat, then type /provider and choose "Ollama (local)"
```

Or, for one headless task:

```bash
amness run --provider ollama --model qwen2.5-coder:7b "list the TODO comments in src"
```

**Why it is useful.** Your code never leaves your machine. Small local models are weaker at calling tools, so start with simple tasks. See [Providers](docs/providers.md).

### 5. Test whether a harness change really helps

Do not guess whether the reviewer, a guard, or a different model helps. Measure it:

```bash
amness eval --builtin hard --variants baseline,full,full+review --trials 3
```

It runs 6 built-in tasks under three setups, 3 times each, and prints a table like this:

```
variant        pass [95% CI]     pass^3   tok/solved   steps   secs
baseline       89% [67%-100%]    83%      15.2k        8.2     11.4
full           83% [50%-100%]    83%      14.7k        8.1     10.5
full+review    89% [67%-100%]    83%      26.3k        9.9     19.5
reading: with 6 tasks only differences above ~81 points can be detected; "inconclusive" means the data cannot tell.
```

**How to read it.**
- `pass` is the share of runs that solved the task, with a 95% confidence range in brackets. A wide range means "not sure yet".
- `pass^3` is the chance that all 3 tries at a task succeed (how reliable it is).
- `tok/solved` is the tokens spent for each solved task. A setup that is cheap but fails a lot is not cheap.
- The last line is the honest summary. Here the answer is: no difference is visible, and `full+review` costs almost twice the tokens. That was a real run (gpt-4.1-mini).

**Why it is useful.** You see what each part of the harness really costs and gives. You can run it on your own tasks too: [Evaluation guide](docs/evaluation.md).

### 6. Add your own rule with a plugin

A plugin is a TypeScript file that runs inside Amness. This one refuses to edit lockfiles and makes the agent say how it verified its work. Save it as `.amness/plugins/house-rules.ts`:

```ts
export default {
  name: "house-rules",
  hooks: {
    // runs before every tool call
    PreToolUse: ({ tool, args }) =>
      /package-lock\.json$/.test(String((args as any).path)) && tool.endsWith("_file")
        ? { block: "lockfiles are generated: run the package manager instead" }   // refuse, and tell the model why
        : undefined,                                                                 // otherwise do nothing
    // runs when the agent tries to finish
    Stop: ({ summary }) =>
      /test|build|lint/i.test(String(summary)) ? undefined : { block: "Say which command you ran to verify this." },
  },
  variants: { strict: { off: [], verify: true } },   // a setup you can compare against the default in an eval
};
```

**What happens.** The next time you start Amness in this project, it asks you to approve the plugin (it shows what the file appears to touch). After that, the two rules apply to every session. A `block` message goes back to the model as the reason, so it can change its plan.

**Compare it with the default** (see example 5):

```bash
amness eval --plugin .amness/plugins/house-rules.ts --variants full,strict --trials 3
```

More plugin ideas (finish gates, policies, loop strategies, custom metrics) are in [Plugins](docs/plugins.md) and the [Cookbook](docs/cookbook.md).

## What you get

| | |
|---|---|
| **A loop that checks itself** | A finish is compared with a record of what really ran (edits, commands, exit codes). Your `verify` command must pass. An optional independent reviewer can object. Loops, stalls and malformed calls are caught. Token budget notes and a final report mean a long run ends with an answer, not a bare "budget exhausted". |
| **Guardrails you control** | Permission rules (allow / ask / deny) with a safety floor that holds even in `yolo`, an OS sandbox (macOS, Linux), secrets masked before the model sees them, commands copied from untrusted text need approval, `/undo` also reverts what shell commands changed. |
| **Cost under control** | Staged context trimming that keeps the provider's prompt cache valid, a shared rate limiter for parallel agents (honours `Retry-After`), subagent budget slices, optional routing of exploration to a cheaper model, optional server-side compaction. |
| **Make it yours** | [Plugins](docs/plugins.md) (in-process hooks on 8 loop events, tools, prompt rewrites, eval graders and variants), shell hooks, skills, custom subagents, MCP servers, your own slash commands, `AGENTS.md`, a library API. |
| **Evaluate and improve** | `amness eval` (ablations, SWE-bench-format suites, injection suite, leak audit), trace replay, failure mining, `amness tune` (changes kept only if they hold on unseen tasks). |
| **Works where you work** | Full-screen and inline terminal UI, headless mode, git worktree sessions with `/review` and `/pr`, scheduled runs, a GitHub Action, an editor server (`amness acp`), image input, session branching. |

Models: OpenAI (Responses and Chat), Claude, and any OpenAI-compatible local server. No runtime dependencies.

## Choose Amness if, choose something else if

**Choose Amness if** you want to pick the model per task or per role, run it from CI with your own limits, write your own guardrails or loop rules as code, compare harness changes with statistics, or read and modify every part of the agent.

**Choose something else if** you want the most polished zero-config experience, you rely on a subscription plan rather than API keys, you need a Windows sandbox or a VS Code extension today, or you do not want to maintain tooling. Amness is young and has one maintainer.

## Status: what is and is not proven

- **Tested:** about 375 automated tests (scripted models, mock servers, real git repositories, a pseudo-terminal), CI on Linux and Windows, and a Docker and npm-package smoke test.
- **Measured on real models (small):** the guards and the reviewer showed no detectable pass-rate effect on [these tasks and models](docs/evaluation.md#measured-results-so-far); the guards and reviewer cost extra tokens, most visibly on strong models. Every newer feature (routing, `tune`, best-of-n, parallel parts, language-server diagnostics, the approval reviewer) is implemented and unit-tested but **not yet shown to help on real work**. The [roadmap](ROADMAP.md) lists the measurements still to run.
- **Platforms:** developed on macOS and Linux. Windows runs the test suite but has no OS sandbox. Not on npm yet.
- Cost figures are estimates. Small local models vary widely in tool-calling quality.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | a step-by-step first session, with screenshots |
| [Cookbook](docs/cookbook.md) | 12 task-based recipes: CI, best-of-n, budgets, plugins, evals, schedules |
| [Using the chat](docs/usage.md) | commands, keys, modes, mentions, images |
| [Features in depth](docs/features.md) | everything above, one section each |
| [Plugins: the harness as code](docs/plugins.md) | write your own loop rules, guardrails, tools and graders |
| [Evaluating the harness](docs/evaluation.md) | `amness eval`, statistics, measured results |
| [Budgets and subagents](docs/budgets.md) | why runs ran out of budget, rate limits, what the vendors recommend |
| [The agent loop](docs/agent-loop.md) · [Architecture](docs/architecture.md) | how it works inside |
| [Providers and local models](docs/providers.md) · [Headless and CI](docs/headless.md) · [Library](docs/library.md) | using it |
| [Safety and privacy](docs/safety.md) | what leaves your machine and what protects it |
| [Development](docs/development.md) · [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) | contributing and what is next |

**Safety in four lines.** Data goes only to the provider you configure; there is no telemetry. File tools stay inside the project and must read a file before editing it; shell commands are **not** sandboxed unless you turn the sandbox on (`/sandbox workspace`). Text from the web or tool servers is treated as data. Treat hooks, plugins, skills and `AGENTS.md` from a repository you cloned as untrusted: project hooks, plugins and allow-rules only run after you approve that exact version of the files.

## Contributing

Issues and pull requests are welcome. `npm install && npm test` runs the suite (about two minutes); `npm run typecheck` checks types; `python3 test/pty/tui.py` drives the real terminal UI. See [docs/development.md](docs/development.md).

Licensed [MIT](LICENSE) © 2026 amirhossein jofreh.
