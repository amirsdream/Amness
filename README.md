# Amness

**Amness is a terminal coding agent that works with any model and does not take "done" on faith.** It checks what the model claims against what actually happened, asks before anything risky, and shows you each step in a full-screen interface.

What sets it apart: guardrails you can measure (a built-in evaluation runner), a safety floor that even `yolo` mode cannot lower, undo that covers shell commands, and a loop built to keep your prompt cache warm. It speaks OpenAI (Responses API), Claude and local models, and has no runtime dependencies.

[![CI](https://github.com/amirsdream/Amness/actions/workflows/ci.yml/badge.svg)](https://github.com/amirsdream/Amness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

<p align="center"><img src="docs/images/chat.png" alt="Amness full-screen interface: cards, diff, sidebar, input panel" width="900"></p>

<sub>The full-screen interface (aurora theme): collapsible tool cards, a diff with word-level marks, the session sidebar and the input panel. Screenshots are rendered from the real UI by the test harness.</sub>

## Contents

- [Why](#why) · [Quick start](#quick-start) · [Using the chat](#using-the-chat) · [More than a chat](#more-than-a-chat) · [Providers and models](#providers-and-models) (including [local models](#providers-and-models))
- [Headless and CI](#headless-and-ci) · [Use it as a library](#use-it-as-a-library) · [Architecture and the agent loop](#architecture) · [Evaluating the harness](#evaluating-the-harness)
- [Safety and privacy](#safety-and-privacy) · [Development](#development) · [Limitations](#limitations) · [Roadmap](ROADMAP.md) · [License](#license)

## Why

Most agent failures are not "the model is dumb"; they are mechanical: malformed tool calls, "I'll now do X" with no action, claiming success without checking, repeating the same call, editing a file it never read, or a context window that quietly fills up. Amness puts a mechanical check on each of those, then wraps it in a comfortable terminal UI:

| Problem | What Amness does |
|---|---|
| Bad tool arguments | Validates against the schema and feeds the exact error back so the model repairs its own call |
| Stops early or only narrates | Nudges it to act; plain answers are still accepted |
| "Done!" without proof | A `verify` command (for example `npm test`) must actually pass before it may finish |
| Edits files it never read | Read-before-edit is enforced; edits need a unique match |
| Dangerous commands | `rm -rf`, `git push`, installs, `curl \| sh` and similar need a human; a hard floor (no `rm -rf /`, no editing `.git`, no force-push to main) holds even in `yolo`, and your own allow/ask/deny rules sit on top |
| Context fills silently | Live context gauge, a map of what fills it, automatic handoff to a fresh context |
| Reasoning lost between tool calls | Reasoning items are replayed with tool results (OpenAI Responses, Claude thinking blocks) |
| Stuck in a failing loop | Reflection prompt after 3 all-failing turns, a clean stop after 6, a wrap-up warning before the step cap |
| Noisy, stale tool output eating the window | Output condensed on arrival; repeated and expired reads dropped; old output elided in one cut |
| Paying full price for the same prefix | Append-only history, stable tool order, cache-break detection, optional Claude keep-alive |
| Memory that grows noisy | Ranked retrieval, duplicate merging, learning from run outcomes, reversible forgetting |
| "Does this guard actually help?" | `amness eval`: paired, task-level statistics with cost per solved task |

## Quick start

Requirements: **Node 22.18 or newer** (it runs the TypeScript sources directly, no build step), git, and an API key for OpenAI or Anthropic, or a local model server such as Ollama.

```bash
git clone https://github.com/amirsdream/Amness.git
cd Amness
npm install

export OPENAI_API_KEY=sk-...        # or: export ANTHROPIC_API_KEY=sk-ant-...
npm start                           # starts the chat in the current directory
```

To use it in your own project, run it from that project's folder (`node /path/to/amness/cli/amness.ts`, or `npm link` once to get an `amness` command):

```bash
amness                              # start a conversation
amness "fix the failing test"       # start with a prompt
amness -c                           # continue the last conversation in this directory
amness --inline                     # use the inline renderer (your terminal's scrollback)
amness --worktree try-x             # work in a fresh git worktree on its own branch
amness menu                         # classic menu: guided demo, evals, research agent, settings
amness demo                         # guided demo, no API key needed
amness eval --selftest              # check the evaluation suite itself (no API key needed)
```

First launch without a key runs a short setup wizard (provider, key, connection test). Keys are read from the environment or saved to `~/.amness/config.json` with mode 600. `/provider` switches later. Claude support needs the optional SDK: `npm install @anthropic-ai/sdk`.

No API key yet? Run `amness demo`: a scripted model makes the mistakes real models make so you can watch each guard catch one.

## Using the chat

`amness` opens a **full-screen interface** by default: a header (project, branch, model, mode), a scrollable transcript of cards, a session sidebar, a rounded input panel and a status line.

- **Calm by default.** Runs of reads and searches collapse into one row ("Explored · 3 files read · 2 searches") that opens on click; edits, commands and failures always get their own card, collapsed one-liners stack tightly, and long diffs show the first 16 rows with a click for the rest. `Ctrl+O` expands everything.
- **Cards.** Your prompts, assistant replies (themed markdown, code blocks with a copy button, tables), collapsible tool cards with status chips, and syntax-highlighted diffs with line numbers and word-level marks (split view on wide terminals).
- **Live run view.** While the agent works, the status line says what it is doing ("Reading src/app.ts", "Running 3 tools in parallel", "Verifying", "Waiting for you") with elapsed time, tokens and the step counter, and the sidebar shows a RUN panel: the think → act → verify pipeline, step progress, running tools with timers, and the last finished actions.
- **Sidebar** (`Ctrl+B`): session, context gauge with a per-request sparkline and breakdown, token usage, todos, changed files, workspace.
- **Copying.** Drag anywhere to select and copy (transcript, sidebar or a modal); double-click copies a word, triple-click a line, and every code block has a working **copy** button. `/copy` copies the last reply (`/copy code` its last code block, `/copy all` the conversation). Copying uses your system clipboard and OSC 52, so it also works over SSH in terminals that support it. Hold **Shift** (**Option** in iTerm2) while dragging to use your terminal's own selection instead, or run `/mouse off`.
- **Mouse.** Wheel scroll, click a card to collapse or expand it, click header chips (model, mode), click suggestions and modal options, drag to select and copy. A "Jump to bottom" pill and a sticky prompt appear while you are scrolled up.
- **Modals** for approvals (with the diff, command or plan), the command palette (`Ctrl+P`), pickers and help.
- **Themes**: `aurora` (default), `tokyo-night`, `catppuccin`, `gruvbox`, `nord`, `daylight` (light), `terminal` (transparent). `/theme` previews live, `Ctrl+T` cycles; truecolor with 256/16-colour fallback.
- Other keys: `PgUp/PgDn`, `Ctrl+Home/End`, `Ctrl+O` expand all, `Ctrl+L` redraw. `/sidebar`, `/details`, `/diffmode`, `/mouse`, `/ui`.

<table>
<tr><td width="50%"><img src="docs/images/approval.png" alt="approval modal with diff"></td><td width="50%"><img src="docs/images/palette.png" alt="command palette"></td></tr>
<tr><td align="center"><sub>Approval modal with the exact diff</sub></td><td align="center"><sub>Command palette (<code>Ctrl+P</code>)</sub></td></tr>
<tr><td colspan="2"><img src="docs/images/running.png" alt="live run view"></td></tr>
<tr><td colspan="2" align="center"><sub>Mid-run: the status line, the RUN panel with step progress and running tools</sub></td></tr>
<tr><td colspan="2"><img src="docs/images/loop.png" alt="/loop trace"></td></tr>
<tr><td colspan="2" align="center"><sub><code>/loop</code>: the agent loop turn by turn, with tools, timings, tokens and the guards that fired</sub></td></tr>
<tr><td><img src="docs/images/welcome.png" alt="welcome screen"></td><td><img src="docs/images/daylight.png" alt="daylight light theme"></td></tr>
<tr><td align="center"><sub>Welcome screen with quick actions</sub></td><td align="center"><sub>Light theme (<code>daylight</code>)</sub></td></tr>
</table>

Prefer your terminal's own scrollback? Run `amness --inline` (or set `ui: "inline"` in the config, or `AMNESS_UI=inline`, or `/ui inline`). It falls back to inline automatically on tiny or `TERM=dumb` terminals.

**Inline mode.** One conversation, a pinned input box, streaming output. Finished output goes into your normal terminal scrollback, so native scrolling, selection and copy work; only the input and status area is redrawn in place.

**What you see.** Each tool call is `● Read(src/a.ts)` with a one-line result (long output is summarised; `Ctrl+O` shows everything). Every edit shows a line-numbered diff. A live todo checklist, a status line with elapsed time and tokens, and a footer with permission mode, git branch, model, context gauge and estimated cost. Tool bullets are coloured by kind (read, edit, shell, web, memory, plan) and red when they fail. Truecolor where available, falling back to 256/16 colours and plain text (`NO_COLOR=1`, or when piped).

**Input.**

| | |
|---|---|
| `Enter` | send (while it works: queue a message that is delivered between steps) |
| `\` then `Enter`, `Alt+Enter`, `Ctrl+J` | new line |
| paste | multi-line paste is one input; large pastes collapse to `[Pasted text #1 +40 lines]` and expand on send |
| `@path` | mention a file (fuzzy popup); its contents are attached |
| `/` | command popup (aliases searchable) |
| `!cmd` | run a shell command now; its output joins the context |
| `#note` | save a memory note |
| `Ctrl+P` / `Alt+M` | command palette / model picker |
| `Shift+Tab` | cycle permission mode |
| `Esc` | interrupt at a safe point · close popup · `Esc Esc` opens rewind |
| `Ctrl+C` | interrupt · clear input · exit (press twice) |
| `Ctrl+O` | expand/collapse all tool details (inline: scrollable transcript) · `Ctrl+L` redraw · `?` shortcuts |
| `Ctrl+B` · `Ctrl+T` | toggle sidebar · cycle theme (full-screen) |
| `PgUp/PgDn` · `Ctrl+Home/End` | scroll the transcript · jump to the end |

**Permission modes** (`Shift+Tab` or `/mode`):

- **default**: asks before edits (showing the diff) and before non-trivial shell commands. Read-only commands (`ls`, `git status`, `grep`…) never ask. "Don't ask again for `npm test`" (or for that tool) is remembered for the session.
- **acceptEdits**: edits apply automatically; shell commands still ask.
- **plan**: read-only. The agent investigates, then presents a plan you approve before it may change anything.
- **yolo**: stops asking for edits and ordinary shell commands. The safety floor still applies (catastrophic deletes, force-push to main, editing `.git` or the rule files are refused; `curl | sh` and force-pushes still ask), but the shell is not sandboxed, so use it in a container or a throwaway checkout with your work committed.

**Slash commands.**

| Command | |
|---|---|
| `/help` · `/status` · `/tools` · `/todos` | information |
| `/model` · `/provider` · `/effort` · `/api` | model, provider, reasoning effort, OpenAI wire API |
| `/mode` · `/plan` · `/verify <cmd>` | permissions, plan mode, the "done must be proven" command |
| `/clear` · `/compact` · `/resume` | new conversation, summarise to free context, continue an earlier one |
| `/undo` · `/rewind` · `/diff` | revert the last turn (files and conversation), go back to a turn, review all changes |
| `/check <cmd>` | fast command run after every edit; only failures reach the model |
| `/loop` (alias `/trace`) | step-by-step trace of the agent loop: each model turn, its tools and timings, and any guard that fired |
| `/tokens` (alias `/cost`) | context gauge, what fills it, tokens, cache hits, estimated cost |
| `/memory` · `/init` | list notes · `forget` `add` `stale` `prune` `consolidate` `graph` `embeddings` · have the agent write `AGENTS.md` |
| `/sandbox [off\|workspace\|strict]` | OS sandbox for shell commands |
| `/profile` | harness settings that apply to this model |
| `/router [on\|off]` | cache-aware routing of exploration steps to the cheap model |
| `/models` | other models for exploring, compacting, reviewing; a fallback model |
| `/agents` | custom subagents available to the task tool |
| `/skills` | skills found (SKILL.md folders) |
| `/procs` | background processes the agent started (`/procs stop <id>`) |
| `/review [base]` · `/pr [draft]` | read-only review of your changes · draft and (after you confirm) create a pull request with gh |
| `/report [case <name>]` | recurring problems in your traces; turn the last request into an eval task |
| `/reviewer [on\|off]` | independent reviewer: acceptance criteria first, a check before work is accepted |
| `/policy` | why recent actions were allowed, asked or refused |
| `/hooks` · `/permissions` | lifecycle hooks in effect · permission rules (list, or `allow`/`ask`/`deny <rule>`) |
| `/copy` | copy the last reply (`/copy code`, `/copy all`) |
| `/keepwarm [on\|off]` | keep the Claude prompt cache alive while you are away (opt-in) |
| `/export` · `/import` · `/live` · `/mcp` | portable bundle, continue from one, browser live view, attach an MCP server |
| `/theme` · `/sidebar` · `/details` · `/diffmode` · `/mouse` · `/ui` | appearance and interface: theme (live preview), sidebar, expand tool details, stacked/split diffs, mouse on/off, full-screen/inline |

**Memory, long sessions and portability.** Plain markdown notes (`.amness/memory`, `~/.amness/memory`) that the agent saves and recalls, ranked, merged and forgotten reversibly; automatic handoff (and `/compact`) keeps long sessions going; `/export` writes a provider-neutral bundle you can continue elsewhere with another model. Details: [Memory](docs/features.md#memory) · [Long sessions](docs/agent-loop.md).

## More than a chat

Each of these is on by default or one command away, and each has a section in [docs/features.md](docs/features.md):

| | |
|---|---|
| **Safety** | [permission rules and a safety floor](docs/features.md#permission-rules-and-the-safety-floor) that even `yolo` cannot lower · an opt-in [OS sandbox](docs/features.md#os-sandbox-opt-in) · [untrusted-content, taint and secret handling](docs/features.md#untrusted-content-taint-and-secrets) · [undo for shell commands](docs/features.md#undoing-what-commands-did) |
| **Control** | [hooks](docs/features.md#hooks) at six points of the loop · [project instructions](docs/features.md#project-instructions) (`AGENTS.md`) · [skills](docs/features.md#skills) · [custom subagents](docs/features.md#custom-subagents) · [branches, review and PRs](docs/features.md#branches-review-and-pull-requests) |
| **Cost** | [cache-aware model routing](docs/features.md#cache-aware-routing-opt-in) · [models per job and a fallback](docs/features.md#models-per-job-and-a-fallback) · [cache behaviour and keep-alive](docs/agent-loop.md) · [a code index](docs/features.md#code-index) |
| **Editing and runs** | [`apply_patch` and multi-edit](docs/features.md#editing) · [background processes](docs/features.md#background-processes) · [tracing](docs/features.md#tracing) · [replay](docs/features.md#replay-test-harness-changes-offline) · [failure mining](docs/features.md#failure-mining) |
| **Measuring** | [`amness eval`](docs/evaluation.md): paired statistics, ablations, benchmarks, an injection suite · [profiles per model](docs/features.md#profiles-what-the-harness-does-for-your-model) |

## Providers and models

| Provider | Notes |
|---|---|
| **OpenAI** | Default model `gpt-6.1-sol`. Reasoning models use the **Responses API**. `/model` lists Sol, Astra, Terra, Luna and earlier models. |
| **Anthropic (Claude)** | Native SDK adapter: streaming, adaptive thinking with `/effort`, automatic prompt caching, server-side refusal fallbacks. Default `claude-opus-5-5`. |
| **OpenRouter, Ollama, vLLM, LM Studio, any OpenAI-compatible server** | Chat Completions. Tool-calling quality depends on the model. |

**Running a local model (Ollama, LM Studio, vLLM, llama.cpp).** Any server with an OpenAI-compatible `/v1` endpoint works:

```bash
# Ollama
ollama pull qwen2.5-coder:7b          # or any model that supports tool calling
amness --provider ollama --model qwen2.5-coder:7b     # base URL defaults to http://localhost:11434/v1

# LM Studio, vLLM, llama.cpp server, anything else
amness --provider custom --base-url http://localhost:1234/v1 --model <model-name>
```

Or run `/provider` inside the chat and pick "Ollama (local)" or "Custom OpenAI-compatible"; the choice is saved. No API key is needed for local servers. Agent work depends on **tool calling**, so pick a model that supports it; small models do better in `/mode plan` with a `--max-tokens` limit, and `amness eval --variants ab` shows whether the guards help the model you chose. Features that need an endpoint Amness cannot assume locally (semantic memory, Claude-only cache keep-alive) say so when you try them.

**Why Responses.** Since GPT-5.4, `/v1/chat/completions` rejects function tools together with reasoning (`400: Function tools with reasoning_effort are not supported … use /v1/responses`). The OpenAI adapter (`src/openai.ts`) speaks both APIs. `/api auto` (default) uses Responses for reasoning models on api.openai.com and Chat Completions elsewhere, and corrects itself at runtime: if a server says to use `/v1/responses` it switches and remembers; if a gateway has no `/responses` it returns to chat with the documented `reasoning_effort: "none"` workaround; an option a server refuses (reasoning summaries for an unverified organisation, an unsupported effort, `prompt_cache_key`) is dropped once instead of failing every request.

In Responses mode requests are stateless (`store: false`): nothing is retained server-side, and opaque reasoning items are replayed with each tool result so multi-step tool use keeps its reasoning. Reasoning summaries stream into the status area while the model thinks. A model switch never replays another model's reasoning.

Environment variables: `AMNESS_UI` (`full` or `inline`), `AMNESS_EMBED_MODEL` (embedding model for semantic memory, default `text-embedding-3-small`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `AMNESS_MODEL`, `TAVILY_API_KEY` (better web search for the research agent), `AMNESS_HOME` (config directory, default `~/.amness`), `NO_COLOR`.

## Headless and CI

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
| `--trace <file>` | JSONL trace of every loop event (`AMNESS_OTLP` for OpenTelemetry export) |
| `--max-tokens <n>` · `--no-memory` | hard token cap · disable memory |

`amness eval` has its own flags (see [Evaluating the harness](#evaluating-the-harness)).

Exit codes: `0` finished, `1` not finished, `2` usage or configuration error.

A `Dockerfile` is included (`docker build -t amness .`, then `docker run -it --rm -v "$PWD":/work -e ANTHROPIC_API_KEY amness`); it has not been built or tested yet.

## Use it as a library

The harness works without the UI. Everything is exported from `src/index.ts`.

```ts
import { createCodeAgent, openai } from "amness";   // or a relative import of src/index.ts

const agent = createCodeAgent({
  model: openai({ model: "gpt-6.1-sol", effort: "high" }),
  cwd: "./my-repo",
  verify: "npm test",                                // "done" must be proven
  approve: ({ name, args, reason }) => false,        // deny risky calls (or ask a human)
});
const result = await agent.run("fix the failing test");
console.log(result.finished, result.text);
```

Building blocks: `createHarness` (the loop: validation and repair, finish gate, nudges, loop guard, budgets, steering, checkpoint/resume, `extract()` for validated JSON), `Registry` (tools that change mid-run, deferred tool search, MCP via `loadMcp`), `createCodeAgent`, `createDeepAgent` (planning, parallel context-isolated subagents, web search, citation checking), `MemoryStore` (ranked, learning memory; plug in an `Embedder` such as `openaiEmbedder` for semantic search), `evaluate`/`harnessVariant`/`analyze` (compare harness variants statistically on held-out checks), `warm()` (cache keep-alive), and the `openai`/`anthropic` model adapters. A model is just `(messages, tools, opts) => Promise<Message>`, so adding a provider is one function.

```ts
import { createHarness, defineTool, openai } from "amness";

const lookup = defineTool<{ id: string }>({
  name: "lookup", description: "Look up an order",
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  run: ({ id }) => db.orders.find(id),
  risky: false,
});
const h = createHarness({ model: openai(), tools: [lookup], verify: () => true, onEvent: console.log });
await h.run("What is the status of order 42?");
```

Because the CLI relies on Node's built-in TypeScript support, Amness is not published to npm yet; use it from a clone or `npm link`.

## Architecture

Three layers with one-way dependencies: the **UI** (`cli/`) drives the **agent** (`src/code.ts`, `src/deep.ts`) built on the **harness** (`src/harness.ts`); models are plain functions injected from outside, so everything in `src/` works as a library and the runtime has no dependencies. Diagram, file map and how the full-screen renderer draws: [docs/architecture.md](docs/architecture.md). The loop itself (steering, budgets, staged compaction, guards, the claims ledger, the optional reviewer, cache behaviour) and the papers behind it: [docs/agent-loop.md](docs/agent-loop.md).

## Evaluating the harness

Every guard and feature can be switched off, so "does this help?" is a measurement: `amness eval --selftest` (free), `--variants ab` (guards or none), `--variants ablate` (each guard removed in turn), `--cases ./my-tasks`, `--suite instances.jsonl` for SWE-bench-format benchmarks, `--builtin adversarial` for prompt-injection attempts. Reports use task-level bootstrap intervals, paired sign tests with Holm correction, `pass^k`, tokens per solved task and an exclusion ledger, and say plainly when the data cannot decide. Full guide: [docs/evaluation.md](docs/evaluation.md).

## Safety and privacy

- **Data leaves your machine only to the provider you configure** (plus web search/fetch if you use the research agent). There is no telemetry. OpenAI requests are stateless by default (`store: false`).
- **Keys** come from environment variables or `~/.amness/config.json` (mode 600). They are never written into a project.
- **File tools are confined to the workspace** and enforce read-before-edit. **Shell commands are not sandboxed unless you turn the sandbox on** (`/sandbox workspace`, macOS and Linux with bubblewrap): otherwise `sh` can do whatever your user can, and the permission prompts and the safety floor are the safeguards, so read them, and prefer the sandbox, `plan` or `default` mode on code you do not trust.
- **Treat project-supplied context as untrusted.** Memory notes and `.amness/commands/` from a repository you cloned can contain prompt injection (so can `AGENTS.md`, which is loaded automatically). Notes are presented to the model as hints to verify, and risky actions still need your approval.
- The browser live view listens on `127.0.0.1` only, rejects foreign `Host` headers, and renders diffs as text, never HTML.
- `.amness/` holds per-project state (chats, checkpoints, handoffs, memory). Add it to your `.gitignore`, except `memory/` and `commands/` if you want to share those.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit over src, cli, tests and examples
npm test               # unit and in-process UI tests (210+), run on Node's built-in test runner
npm run test:pty       # the real binary in a pseudo-terminal against a mock streaming server (needs python3)
```

The UI tests drive the real `App` with simulated keystrokes and read the screen back through a small VT100 emulator (`test/helpers/vterm.ts`), so layout, cursor placement and redraw behaviour are checked, not just strings. Model providers are exercised against scripted and mock HTTP servers, including one that reproduces OpenAI's "tools with reasoning" 400. Contributions are welcome: please keep `npm run typecheck` and `npm test` green.

## Limitations

- Developed and tested on macOS and Linux terminals; Windows is untested.
- Automated tests use scripted models and mock servers. Behaviour against live provider APIs has been checked by hand only, and provider APIs change; if one breaks, open an issue with the error text.
- Cost figures are estimates (no invoices, cached input assumed at about 10% of the input price, and some models have no price listed).
- Newer features (cache keep-alive, semantic memory, `amness eval` against a real model) are covered by tests with scripted models and mock servers, but have not been run against live provider APIs. The efficiency numbers quoted from papers are theirs, not measurements of Amness.
- Semantic memory sends note text and your messages to your provider's embeddings endpoint, and needs an OpenAI-compatible provider (Claude has none).
- Gaps compared with other harnesses (hooks, OS sandbox, skills, custom subagents, background processes and more) are tracked in [ROADMAP.md](ROADMAP.md), together with a second track of ideas for getting ahead of them (grounded verification, trace replay, cache-aware routing, taint-based security, bounded self-improvement).
- Not on npm yet (see above), and the Docker image is untested.
- Tool-calling quality with small local models varies widely.

## License

[MIT](LICENSE) © 2026 amirhossein jofreh
