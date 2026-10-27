# Amness

**A terminal coding agent for any model, with guardrails.** A full-screen terminal UI (cards, diffs, a live run view, a session sidebar, mouse and copy support), permission prompts with diffs, plan mode, undo, MCP, and a memory that learns what helps, all on a small reliability harness for OpenAI (Responses API), Claude and local models. The loop is cache-aware and every guard can be measured with a built-in statistical eval runner.

[![CI](https://github.com/amirsdream/Amness/actions/workflows/ci.yml/badge.svg)](https://github.com/amirsdream/Amness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

<p align="center"><img src="docs/images/chat.png" alt="Amness full-screen interface: cards, diff, sidebar, input panel" width="900"></p>

<sub>The full-screen interface (aurora theme): collapsible tool cards, a diff with word-level marks, the session sidebar and the input panel. Screenshots are rendered from the real UI by the test harness.</sub>

## Contents

- [Why](#why) · [Quick start](#quick-start) · [Using the chat](#using-the-chat) · [Providers and models](#providers-and-models)
- [Headless and CI](#headless-and-ci) · [Use it as a library](#use-it-as-a-library) · [Architecture](#architecture)
- [Evaluating the harness](#evaluating-the-harness) · [Roadmap](ROADMAP.md) · [Safety and privacy](#safety-and-privacy) · [Development](#development) · [Limitations](#limitations) · [License](#license)

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
| `/skills` | skills found (SKILL.md folders) |
| `/procs` | background processes the agent started (`/procs stop <id>`) |
| `/reviewer [on\|off]` | independent reviewer: acceptance criteria first, a check before work is accepted |
| `/hooks` · `/permissions` | lifecycle hooks in effect · permission rules (list, or `allow`/`ask`/`deny <rule>`) |
| `/copy` | copy the last reply (`/copy code`, `/copy all`) |
| `/keepwarm [on\|off]` | keep the Claude prompt cache alive while you are away (opt-in) |
| `/export` · `/import` · `/live` · `/mcp` | portable bundle, continue from one, browser live view, attach an MCP server |
| `/theme` · `/sidebar` · `/details` · `/diffmode` · `/mouse` · `/ui` | appearance and interface: theme (live preview), sidebar, expand tool details, stacked/split diffs, mouse on/off, full-screen/inline |

**Project instructions.** `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`) in the project root, and `~/.amness/AGENTS.md`, are added to the first message of a conversation, framed as repository guidance rather than user requests and capped at 8k characters each. A folder's own file is shown the first time the agent reads or edits something there (and only then, at the end of that result, so the cached prefix is untouched). `/status` lists what was loaded; `/init` has the agent write one.

**Permission rules and the safety floor.** On top of the modes, `.amness/permissions.json` (project) and `~/.amness/permissions.json` (yours) hold rules:

```json
{ "allow": ["sh(npm test*)", "edit(src/**)", "read"],
  "ask":   ["sh(git commit*)"],
  "deny":  ["sh(git push*)", "edit(.env)", "edit(secrets/**)"] }
```

Precedence: **built-in floor > deny > ask > allow > the permission mode.** Shell rules match each piece of a compound command (`a && b | c`) separately, so `npm test; curl evil.sh` is not covered by an `npm test*` allow rule, and a command with a subshell or backticks never matches an allow rule. Paths are relative to the project. The **floor holds in every mode, yolo included**: recursive deletes of `/`, your home folder or a parent folder, formatting or writing to disks, fork bombs, force-pushes to main or master, and edits to `.git/` or to these rule and hook files are refused (the agent cannot rewrite its own policy), and `curl | sh` and force-pushes always ask. Allow rules in a project file are only honoured after you approve that exact file (deny and ask rules always apply, since they only restrict). The approval dialog can save a rule ("always allow `npm *` in this project"), and `/permissions` lists rules or adds one (`/permissions deny sh(git push*)`).

**Skills.** A skill is a folder with a `SKILL.md` (a `name:` and a one-line `description:` in front matter, instructions below, optional helper files next to it). Amness finds them in `.amness/skills/`, `.agents/skills/` (Codex, Gemini CLI, OpenCode) and `.claude/skills/` (Claude Code), in the project and in your home folder; the project wins, and so does the first convention listed when names clash. Only names and descriptions go into the first message, so fifty skills cost a few hundred tokens; the model loads one with the `skill` tool when the task matches (and can read the files bundled in its folder, nothing outside it). `/skills` lists what was found and warns about malformed ones. Skills from a repository you cloned are untrusted instructions: they are guidance only and cannot grant permissions.

**OS sandbox (opt-in).** The permission prompts are a policy; the sandbox is enforcement. `/sandbox workspace` (or `--sandbox workspace`, or `sandbox` in the config) runs every shell command, including background ones, under macOS Seatbelt or Linux Bubblewrap: commands can read the machine but write only in the project, temp folders and common package caches, `.git` and the rule files stay read-only, and in `/sandbox strict` the network is cut as well (so `npm install` will fail). It makes yolo mode far safer. If a sandbox is requested where none exists (Windows, or Linux without `bwrap`), commands are refused instead of silently running unprotected. The file tools were already confined to the workspace.

**Editing.** Four ways to change files, all subject to read-before-edit and the same permission rules: `edit_file` (exact, unique match; or an `edits` list of several replacements applied in order, all or nothing; text that differs only in indentation is still matched when it is unique, and the result says so), `write_file`, and `apply_patch` for changes that span files. `apply_patch` takes the envelope used by Codex (`*** Begin Patch`, `*** Update File: path` with `@@` hunks, `*** Add File`, `*** Delete File`, `*** Move to`, `*** End Patch`) or an ordinary unified diff, applies hunks in order (an `@@ function name` anchor narrows the search), and is **atomic**: if any hunk of any file fails, nothing is written and every failure is named. A patch is judged file by file by permission rules, so one denied file denies the patch.

**Background processes.** `sh` waits for a command to finish, so servers and watchers use four more tools: `sh_start` (returns an id; same permission rules as `sh`), `sh_read` (new output since the last read, optionally waiting up to 10 s), `sh_stop` (SIGTERM, then SIGKILL; the whole process group) and `sh_list`. Output is kept in a 200 KB ring buffer, at most 5 run at once, plan mode hides `sh_start`, and everything is killed when you exit. The sidebar lists running processes and `/procs` shows or stops them.

**Tracing.** Every loop event (turns with token and cache counts, tool calls with timings, hooks, cache breaks, trims) is written to `.amness/traces/<session>.jsonl`, one JSON line each, so a bad session can be read with `grep` and `jq`. Set `AMNESS_OTLP=http://localhost:4318` (or any OTLP/HTTP collector) to also export OpenTelemetry spans with GenAI attributes (`gen_ai.usage.input_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.tool.name`); headless runs take `--trace <file>`. `/loop` shows how many tokens were re-read at full price after cache breaks, with an estimated cost. A full disk or an unreachable collector never stops the agent.

**Hooks.** Run your own commands at fixed points of the loop, in the same vocabulary as Claude Code and Codex. Configure them in `.amness/hooks.json` (project) and `~/.amness/hooks.json` (yours):

```json
{ "PreToolUse":  [{ "match": "sh", "command": "./scripts/no-push.sh", "timeout": 10 }],
  "PostToolUse": [{ "match": "edit_file|write_file", "command": "npx prettier --write ." }],
  "Stop":        [{ "command": "./scripts/changelog-updated.sh" }] }
```

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`. The event arrives as JSON on stdin. Exit `0` allows; exit `2` blocks (stderr goes to the model, or for `UserPromptSubmit` back to you); stdout can be plain text (added as context) or JSON (`{"context": "..."}`, `{"args": {...}}` to rewrite a tool call, `{"decision": "block", "reason": "..."}`). Hooks run without your API keys in their environment, time out after 10 s, and a crash only warns unless the hook sets `"failClosed": true`. **Project hooks run commands on your machine, so Amness asks before running a repository's hooks and remembers your answer for that exact file** (headless runs need `--trust-project`). `/hooks` shows what is active.

**Your own commands.** Put `review.md` in `.amness/commands/` (or `~/.amness/commands/`) and `/review <args>` runs it as a prompt (`$ARGUMENTS` is substituted; a `description:` front-matter line shows in the popup). Commit the folder to share it with your team.

**Memory.** Plain markdown notes in `<project>/.amness/memory` and `~/.amness/memory`, indexed by `MEMORY.md`; edit them like any file. What makes it more than a notebook:

- **Cache-friendly injection.** At the start of a conversation the agent sees a short index (the 25 most relevant or useful notes) plus the notes that best match your request, framed as hints to verify. Later messages add only *new* relevant notes, at the end, so the earlier conversation never changes.
- **Ranked retrieval.** BM25 over name, description and content, with light stemming, blended with how often a note proved useful. Optional **semantic search** (`/memory embeddings on`, OpenAI-compatible providers) adds embedding similarity so a note can match without sharing a word; vectors are cached in `memory/embeddings.json` and recomputed only for changed notes. If the embeddings call fails, keyword search carries on.
- **Learning from outcomes.** Notes that were in front of the model during runs that finished (passed `verify`) rank higher; notes from runs that got stuck or ran out of steps rank lower. A note with 4+ bad runs and under 25% good is suggested for archiving. A plain chat reply changes nothing.
- **Duplicates merge.** Saving a note that says nearly the same as an existing one (same type) updates it instead; the newer wording wins.
- **A small graph.** `[[other-note]]` mentions, and notes that keep being retrieved together, become neighbours; a match pulls its neighbours in at lower rank (`/memory graph`).
- **Forgetting you can undo.** `/memory stale` lists notes never useful (or consistently unhelpful); `/memory prune` moves them to `memory/archive/`. `/memory consolidate` has the model propose merges and archives, shows the plan, and applies it only if you agree. Nothing is deleted.

The agent saves durable lessons itself (the real test command, your corrections).

**Long sessions.** Context is managed in stages (see [the agent loop](#the-agent-loop)): noisy output is condensed on arrival, stale output is trimmed in one batch only when the window needs it, and past a threshold the model writes a handoff note and the run continues in a fresh context seeded with the task and that note. For Claude, history is never edited (that keeps its thinking blocks and cache valid), so only the handoff applies. `/compact` does the handoff on demand.

**Portability.** `/export` (or `--export`) writes a provider-neutral bundle: the task, a model-written handoff note, the files the agent changed, and your memory. It deliberately contains no raw transcript, so you can continue on another machine, in another checkout, or with a different model: `amness run --bundle f.json "carry on"`.

## Providers and models

| Provider | Notes |
|---|---|
| **OpenAI** | Default model `gpt-6.1-sol`. Reasoning models use the **Responses API**. `/model` lists Sol, Astra, Terra, Luna and earlier models. |
| **Anthropic (Claude)** | Native SDK adapter: streaming, adaptive thinking with `/effort`, automatic prompt caching, server-side refusal fallbacks. Default `claude-opus-5-5`. |
| **OpenRouter, Ollama, vLLM, LM Studio, any OpenAI-compatible server** | Chat Completions. Tool-calling quality depends on the model. |

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

Three layers with one-way dependencies: the **UI** (`cli/`) drives the **agent** (`src/code.ts`, `src/deep.ts`) which is built on the **harness** (`src/harness.ts`); models are plain functions injected from outside. The harness and the agents have no dependency on the UI, so everything in `src/` is usable as a library.

```mermaid
flowchart TB
  subgraph UI["cli/ : terminal interface"]
    direction TB
    entry["amness.ts<br/>chat · run · menu · demo"]
    app["tui/app.ts<br/>App: input, modes, approvals,<br/>slash commands, sessions"]
    full["Full-screen view<br/>full.ts · cards · sidebar · modal<br/>canvas · themes · blocks"]
    inline["Inline view<br/>screen.ts · view.ts"]
    entry --> app
    app --> full
    app --> inline
  end
  subgraph AGENT["src/ : agents"]
    code["code.ts<br/>coding agent + file/shell tools"]
    deep["deep.ts<br/>research agent + subagents"]
  end
  subgraph CORE["harness.ts : the loop"]
    loop["run(): steer → budget → compact →<br/>model → schedule tools → verify"]
    reg["Registry<br/>deferred tools · MCP"]
  end
  subgraph MODELS["model adapters"]
    oa["openai.ts<br/>Responses + Chat Completions"]
    an["anthropic.ts<br/>Claude"]
    local["any (messages, tools) → message"]
  end
  subgraph STATE["state"]
    mem["memory.ts<br/>ranked, learning notes<br/>embed.ts: optional vectors"]
    bundle["bundle.ts<br/>portable sessions"]
    sess["cli/tui/session.ts<br/>chats + checkpoints"]
  end
  app -->|"events up, prompts down"| code
  code --> loop
  deep --> loop
  loop --> reg
  loop -->|"model(messages, tools)"| oa
  loop --> an
  loop --> local
  code --> mem
  app --> sess
  app --> bundle
  ev["evals.ts + stats.ts<br/>variants, bootstrap, sign test"] --> code
  evcli["cli/evalcli.ts<br/>amness eval"] --> ev
```

| Path | Role |
|---|---|
| `cli/amness.ts` | entry point: chat (default), headless `run`, classic `menu`, `demo`; chooses full-screen or inline |
| `cli/tui/app.ts` | the `App`: key handling, permission modes, approvals, slash commands, queued steering, undo/rewind |
| `cli/tui/full.ts` + `cards.ts`, `sidebar.ts`, `modal.ts`, `diffview.ts` | full-screen view: layout, transcript cards, sidebar, modals, diff renderer |
| `cli/tui/blocks.ts` | retained transcript model (user, assistant, tool, thinking, notice blocks) that the full-screen view renders from |
| `cli/tui/canvas.ts`, `ansi.ts`, `themes.ts`, `rich.ts` | cell grid with diffing flush, ANSI parsing, the seven themes, shared styling helpers |
| `cli/tui/screen.ts`, `view.ts` | the inline renderer (live region plus native scrollback) |
| `src/harness.ts` | the agent loop and guards (see below); `Registry`, `Budget`, `extract()` |
| `src/code.ts`, `src/deep.ts` | coding agent (file and shell tools, subagent `task`, todos, plan mode) and research agent |
| `src/openai.ts`, `src/anthropic.ts` | model adapters; a model is just `(messages, tools, opts) => Promise<Message>` |
| `src/memory.ts`, `src/embed.ts` | memory: ranking, merging, graph, outcome learning, archive; optional embeddings |
| `src/bundle.ts`, `src/dynamic.ts` | portable session bundles; live tool registry and MCP |
| `src/evals.ts`, `src/stats.ts`, `src/evalcases.ts`, `cli/evalcli.ts` | the eval runner: variants and ablations, task-level statistics, built-in tasks, `amness eval` |
| `cli/tui/clipboard.ts` | clipboard (OSC 52 plus the platform tool) |
| `src/live.ts` | browser live view (`127.0.0.1` only) |

**How the full-screen UI draws.** Agent events are written into the block store; each block renders to rows of styled cells (cached by content signature); the view lays out header, transcript, sidebar, input and footer onto a `Canvas`, and `Canvas.flush()` writes only the cells that changed, wrapped in synchronized-output markers so frames never tear. Mouse (SGR 1006), bracketed paste and OSC 52 clipboard are enabled while it runs and restored on exit. The inline renderer shares the same `App` and agent events, so both interfaces behave identically.

The runtime has no dependencies.

## The agent loop

```mermaid
flowchart LR
  A["steer<br/>messages typed meanwhile"] --> B["budget<br/>check"] --> C["compact<br/>supersede · elide · handoff"] --> D["model call<br/>streaming"]
  D -->|tool calls| E["validate · approve ·<br/>schedule: reads in parallel,<br/>writes one at a time"]
  E --> F{"all failed?"}
  F -->|"3×: reflect, 6×: stop"| A
  F -->|no| A
  D -->|finish| G{"verify gate<br/>npm test"}
  G -->|rejected + feedback| A
  G -->|passes| H(["done"])
```

Each turn: steer (messages you typed meanwhile) → budget check → compaction → model call → tool calls → verification gate. The details that keep long runs reliable:

- **Scheduling.** Read-only and subagent calls in one turn run concurrently (up to 5); anything that can change state runs alone, in the order issued. Mark your own tools `readOnly` or `parallel` to opt in.
- **Compaction in stages, cheapest first.** Observations are condensed as they arrive (terminal codes and progress redraws stripped, repeated lines collapsed, long output cut to head and tail plus its error lines). Older output that is repeated or **expired** (a read of a file that was edited afterwards) is dropped, then old tool output is elided, and only on very long runs does the model write a handoff note and continue in a fresh context. Elision cuts well below the budget in one go, so the provider's prompt-cache prefix stays valid between cuts. `/loop` shows how much was trimmed.
- **Post-edit check.** `/check <cmd>` (headless `--check`, library `check`) runs a fast command such as a typecheck after every edit. Only a failure is shown to the model, appended to the edit result, so a mistake is caught one step after it happens instead of at the end.
- **Guards.** Repeat-call detection (the same call, normalised, with nothing edited in between; re-running tests after an edit is fine), cycle detection (2 to 4 different calls repeating three times, such as an edit flipped back and forth around a test run), a nudge when the model announces an action instead of taking it, a wrap-up warning three steps before the step cap, and no-progress detection (a reflection prompt after 3 all-failing turns, a clean stop after 6).
- **Stagnation is judged from objective signals.** A loop that keeps acting while nothing measurable improves gets a structured reflection after 8 such turns and a clean stop after 12. "Improves" means: the failing-test, error or lint count reaches a new low (parsed from Jest, pytest, Go, Cargo, the Node runner, `tsc`, `eslint`...), a file is edited for the first time, an edit adds a change that is not the undo of an earlier one, or something new is read (capped). The model's own confidence counts for nothing. Tune with `stagnationTurns`; `off: ["stagnation"]` switches it off for ablations.
- **Claims are checked against a record.** The harness records what really happened (files edited, commands run and their exit codes) and compares the `finish` summary with it: "all tests pass" needs a passing test run *after the last edit*, "build is clean" needs a successful build or typecheck, and a file named as changed must have been edited. A mismatch is rejected with the specifics (at most twice, so it can never deadlock). Accepted runs end with an audit line: files changed, whether tests passed after the final edit, test files touched when the task did not mention tests. Agents that judge their own work accept plausible progress as real progress ([When Do Agent Loops Mistake Stagnation for Progress?](https://arxiv.org/abs/2607.25152)); this is the cheap external check.
- **Independent reviewer (opt-in, `/reviewer on` or `--review`).** Builders overpraise their own work, and a separate judge is easier to make sceptical than a builder is to make self-critical ([Anthropic's long-running harness write-up](https://www.anthropic.com/engineering/harness-design-long-running-apps)). Before a task-like message, a fresh context writes 3 to 7 testable acceptance criteria that the builder sees; before a `finish` is accepted (after the ledger and your `verify` command), a read-only reviewer that can run only the project's own test, build and lint commands checks the diff against them. Findings go back to the builder; after two rounds the work is accepted and flagged, and an unusable verdict never blocks. It costs roughly two to four extra model calls per task and can use a different model (`review: { model }`), so it is off by default; measure it with `amness eval --variants full,full+review`.
- **Done means verified.** `finish` passes through your `verify` gate (tests, build) and is rejected with feedback until it holds.

### Prompt cache and memory

Cached input costs a fraction of fresh input, so the loop is built to keep the request prefix identical from turn to turn:

- **Append-only by default.** Old messages are rewritten only when the window needs it, and then in one cut well below the budget (so a rewrite happens every several turns, not every turn). New information (steering messages, relevant memory notes) always goes at the *end*.
- **Stable request shape.** Tool definitions are sorted by name, the memory index is injected once per conversation, and OpenAI requests carry a stable per-project `prompt_cache_key` with 24-hour cache retention (dropped automatically for models that refuse it). Claude requests use automatic caching on an append-only transcript.
- **Keep-alive (opt-in).** Claude drops a cached prefix after about 5 idle minutes. `/keepwarm on` re-sends the conversation with a 16-token output cap about every 4.5 minutes while you are away (at most 3 times per break), which costs a cache read instead of a cold re-read. It is off by default because it spends tokens while you are not looking, and it only applies to Claude (OpenAI requests already ask for 24-hour retention).
- **You can see it.** `/loop` marks every turn where the prefix changed ("cache break: earlier history was rewritten at message 14", "the tool list changed") and counts them; the usage panel shows the cache hit rate; `amness eval` reports it per variant, so you can measure what a change does to cost.

### Where these choices come from

Recent work on coding-agent loops points the same way, and the loop follows it where it can be done without training a model:

- [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804) (2026): cheap rule-based elision before any LLM summarisation gave the lowest cost; a recall tool for elided content was almost never used, so there isn't one; stuck detection and lightweight post-edit checks are cheap ways to stop wasted turns.
- [AgentDiet](https://arxiv.org/abs/2509.23586) (trajectory reduction): removing useless, redundant and *expired* information cut input tokens 40-60% with unchanged results. This is the source of the expired-read and repeated-call rules.
- [CoACT](https://arxiv.org/abs/2607.02911) and [SWE-Pruner](https://arxiv.org/abs/2601.16746): reads dominate token use, and compression must preserve what the next action needs, and leave earlier messages untouched to keep the cache valid. Amness uses rules for this; the papers use trained compressors, which would add a dependency.
- [Don't Break the Cache](https://arxiv.org/abs/2601.06007) (prompt caching for long-horizon agents): caching cut API cost by 41-80% across OpenAI, Anthropic and Google, but naive full-context caching can hurt; put dynamic content at the end, avoid dynamic tool lists, keep dynamic tool results out of the cached prefix. [Keeping the Cache Warm Pays](https://arxiv.org/abs/2607.19214) motivates the longer OpenAI retention and the opt-in Claude keep-alive.
- Memory: [Infini Memory](https://arxiv.org/abs/2606.10677) (plain-text topic documents, lexical retrieval, merge/split maintenance, recency resolves contradictions; its structural maintenance mattered most in its ablations), [REALM](https://arxiv.org/abs/2609.16053) (retrieval feeds back into how memory is organised, which is why Amness records use and ranks by it) and the strategic-forgetting work ([SF-AMS](https://arxiv.org/abs/2607.22562), [FSFM](https://arxiv.org/abs/2604.20300)). Amness implements these with plain files: lexical plus optional embedding retrieval, merge maintenance (`/memory consolidate`), a light note graph with use-driven links, outcome-based ranking and reversible forgetting. "Learning" here means simple statistics (wins and losses per note), not a trained model, and there is no graph database.
- A [source-code study of eleven coding agents](https://arxiv.org/html/2609.00006v1): read-only tools run concurrently, mutating tools one at a time.

The percentages above are the papers' results on their own benchmarks, not measurements of Amness; use the eval runner (`evaluate`) with the guards switched on and off to measure them on your tasks.

## Evaluating the harness

Every guard and efficiency feature can be switched off, so "does this help?" is a measurement, not an opinion:

```bash
amness eval --selftest                       # prove every task is solvable and its held-out check is sound (no model, free)
amness eval --variants ab --trials 3         # baseline (no guards) vs full harness on 12 built-in tasks
amness eval --variants ablate --trials 5     # full harness, then each guard removed in turn
amness eval --cases ./my-tasks --jobs 3      # your own tasks: a folder of *.json
amness eval --report .amness/evals/<run>.json   # re-analyse saved results, runs nothing
```

Each task runs in a fresh temporary workspace. The agent sees the task and an optional `verify` command; a **held-out `check`** it never sees decides pass or fail. Variants: `baseline`, `full`, `full+check`, `no-gate`, and `full-<guard>` for each of `nudge loop compact stuck wrapup condense schedule ledger`.

What the report gives you, and why:

- **Tasks are the unit of analysis.** Repeated trials of one task are correlated, so intervals are 95% bootstrap intervals over tasks, and comparisons are paired by task.
- **A paired comparison against the baseline:** change in pass rate with its interval, wins/losses/ties, an exact sign test (McNemar's exact test on the tasks where two variants differ) with Holm correction across variants, and a verdict of `better`, `worse` or `inconclusive`.
- **Reliability, not just a pass rate:** `pass^k` is the chance that k attempts at a task *all* pass, which exposes variants that only succeed sometimes.
- **Cost per solved task, not per run:** a variant that is cheap because it gives up is not efficient. A `●` marks variants on the pass-rate versus tokens-per-solve Pareto frontier.
- **Why a variant behaves as it does:** how often each guard fired per run (nudges, loop blocks, rejected finishes, trimmed output).
- **An honest power note.** With 12 tasks only large differences (about 60 points) are detectable; the report says so instead of declaring a winner. Add tasks with `--cases` before trusting a small difference.

The method follows recent evaluation practice: harness choice can change cost per solved task by large factors while pass-rate differences stay small ([The Scaffold Effect in Coding Agents](https://arxiv.org/abs/2607.22585)), and task-level paired bootstrap intervals are the right uncertainty statement ([Harness or Model?](https://arxiv.org/html/2609.11987v1)). The built-in suite is small and synthetic; it is a regression harness for the guards, not a substitute for SWE-bench-style benchmarks, and a real run costs real tokens (the command asks before starting).

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
