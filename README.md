# amness

**A terminal coding agent for any model, with guardrails.** One conversation in your terminal, streaming output, permission prompts with diffs, plan mode, undo, memory and MCP, built on a small reliability harness that works with OpenAI (Responses API), Claude, and local models.

[![CI](https://github.com/amirsdream/amness/actions/workflows/ci.yml/badge.svg)](https://github.com/amirsdream/amness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

```
╭─ welcome ────────────────────────────────────────────────────╮
│  ▗▄▄▄▄▄▖   ▄▀█ █▀▄▀█ █▄ █ █▀▀ █▀ █▀                          │
│  █ ◖ ◗ █   █▀█ █ ▀ █ █ ▀█ ██▄ ▄█ ▄█                          │
│  ▝▀▀▀▀▀▘   v0.1.0 · reliable agents for any model            │
│                                                              │
│ model    ◈ gpt-6.1-sol                                       │
│ project  ~/code/my-app  ⎇ main                               │
╰──────────────────────────────────────────────────────────────╯

❯ fix the off-by-one in paginate()

● Search("paginate")
  ⎿  3 matches in 2 files
● Read(src/app.ts)
  ⎿  Read 6 lines
● Update(src/app.ts)
  ⎿  Added 1 line, removed 1 line
       3 -   for (let i = 0; i < n; i++) out.push(items[i]);
       3 +   for (let i = 0; i <= n; i++) out.push(items[i]);

✻ Working… (12s · ↓ 4.2k tokens ▂▄▆ · esc to interrupt)
──────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────
 ? for shortcuts · ctrl+p commands      ◈ gpt-6.1-sol · ▰▰▱▱▱▱▱▱ 24% · $0.18
```

<sub>Abridged, illustrative session (the welcome card is the real layout).</sub>

## Contents

- [Why](#why) · [Quick start](#quick-start) · [Using the chat](#using-the-chat) · [Providers and models](#providers-and-models)
- [Headless and CI](#headless-and-ci) · [Use it as a library](#use-it-as-a-library) · [Architecture](#architecture)
- [Safety and privacy](#safety-and-privacy) · [Development](#development) · [Limitations](#limitations) · [License](#license)

## Why

Most agent failures are not "the model is dumb"; they are mechanical: malformed tool calls, "I'll now do X" with no action, claiming success without checking, repeating the same call, editing a file it never read, or a context window that quietly fills up. amness puts a mechanical check on each of those, then wraps it in a comfortable terminal UI:

| Problem | What amness does |
|---|---|
| Bad tool arguments | Validates against the schema and feeds the exact error back so the model repairs its own call |
| Stops early or only narrates | Nudges it to act; plain answers are still accepted |
| "Done!" without proof | A `verify` command (for example `npm test`) must actually pass before it may finish |
| Edits files it never read | Read-before-edit is enforced; edits need a unique match |
| Dangerous commands | `rm -rf`, `git push`, installs, `curl \| sh` and similar always need a human |
| Context fills silently | Live context gauge, a map of what fills it, automatic handoff to a fresh context |
| Reasoning lost between tool calls | Reasoning items are replayed with tool results (OpenAI Responses, Claude thinking blocks) |

## Quick start

Requirements: **Node 22.18 or newer** (it runs the TypeScript sources directly, no build step), git, and an API key for OpenAI or Anthropic, or a local model server such as Ollama.

```bash
git clone https://github.com/amirsdream/amness.git
cd amness
npm install

export OPENAI_API_KEY=sk-...        # or: export ANTHROPIC_API_KEY=sk-ant-...
npm start                           # starts the chat in the current directory
```

To use it in your own project, run it from that project's folder (`node /path/to/amness/cli/amness.ts`, or `npm link` once to get an `amness` command):

```bash
amness                              # start a conversation
amness "fix the failing test"       # start with a prompt
amness -c                           # continue the last conversation in this directory
amness menu                         # classic menu: guided demo, evals, research agent, settings
amness demo                         # guided demo, no API key needed
```

First launch without a key runs a short setup wizard (provider, key, connection test). Keys are read from the environment or saved to `~/.amness/config.json` with mode 600. `/provider` switches later. Claude support needs the optional SDK: `npm install @anthropic-ai/sdk`.

No API key yet? Run `amness demo`: a scripted model makes the mistakes real models make so you can watch each guard catch one.

## Using the chat

One conversation, a pinned input box, streaming output. Finished output goes into your normal terminal scrollback, so native scrolling, selection and copy work; only the input and status area is redrawn in place.

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
| `Ctrl+O` | scrollable full transcript · `Ctrl+L` redraw · `?` shortcuts |

**Permission modes** (`Shift+Tab` or `/mode`):

- **default**: asks before edits (showing the diff) and before non-trivial shell commands. Read-only commands (`ls`, `git status`, `grep`…) never ask. "Don't ask again for `npm test`" (or for that tool) is remembered for the session.
- **acceptEdits**: edits apply automatically; shell commands still ask.
- **plan**: read-only. The agent investigates, then presents a plan you approve before it may change anything.
- **yolo**: never asks. Use deliberately.

**Slash commands.**

| Command | |
|---|---|
| `/help` · `/status` · `/tools` · `/todos` | information |
| `/model` · `/provider` · `/effort` · `/api` | model, provider, reasoning effort, OpenAI wire API |
| `/mode` · `/plan` · `/verify <cmd>` | permissions, plan mode, the "done must be proven" command |
| `/clear` · `/compact` · `/resume` | new conversation, summarise to free context, continue an earlier one |
| `/undo` · `/rewind` · `/diff` | revert the last turn (files and conversation), go back to a turn, review all changes |
| `/tokens` (alias `/cost`) | context gauge, what fills it, tokens, cache hits, estimated cost |
| `/memory` · `/init` | list/forget/add memory notes · have the agent write `AGENTS.md` |
| `/export` · `/import` · `/live` · `/mcp` | portable bundle, continue from one, browser live view, attach an MCP server |

**Your own commands.** Put `review.md` in `.amness/commands/` (or `~/.amness/commands/`) and `/review <args>` runs it as a prompt (`$ARGUMENTS` is substituted; a `description:` front-matter line shows in the popup). Commit the folder to share it with your team.

**Memory.** Plain markdown notes in `<project>/.amness/memory` and `~/.amness/memory`, indexed by `MEMORY.md`. The agent sees the index plus the notes most relevant to your request, framed as hints to verify, and saves durable lessons itself (the real test command, your corrections). Edit them like any file.

**Long sessions.** When the context grows past a threshold the model writes a handoff note and the run continues in a fresh context seeded with the task and that note. History is never edited, which keeps Claude's thinking blocks and prompt caches valid, and it works the same on every provider. `/compact` does it on demand.

**Portability.** `/export` (or `--export`) writes a provider-neutral bundle: the task, a model-written handoff note, the files the agent changed, and your memory. It deliberately contains no raw transcript, so you can continue on another machine, in another checkout, or with a different model: `amness run --bundle f.json "carry on"`.

## Providers and models

| Provider | Notes |
|---|---|
| **OpenAI** | Default model `gpt-6.1-sol`. Reasoning models use the **Responses API**. `/model` lists Sol, Astra, Terra, Luna and earlier models. |
| **Anthropic (Claude)** | Native SDK adapter: streaming, adaptive thinking with `/effort`, automatic prompt caching, server-side refusal fallbacks. Default `claude-opus-5-5`. |
| **OpenRouter, Ollama, vLLM, LM Studio, any OpenAI-compatible server** | Chat Completions. Tool-calling quality depends on the model. |

**Why Responses.** Since GPT-5.4, `/v1/chat/completions` rejects function tools together with reasoning (`400: Function tools with reasoning_effort are not supported … use /v1/responses`). The OpenAI adapter (`src/openai.ts`) speaks both APIs. `/api auto` (default) uses Responses for reasoning models on api.openai.com and Chat Completions elsewhere, and corrects itself at runtime: if a server says to use `/v1/responses` it switches and remembers; if a gateway has no `/responses` it returns to chat with the documented `reasoning_effort: "none"` workaround; an option a server refuses (reasoning summaries for an unverified organisation, an unsupported effort, `prompt_cache_key`) is dropped once instead of failing every request.

In Responses mode requests are stateless (`store: false`): nothing is retained server-side, and opaque reasoning items are replayed with each tool result so multi-step tool use keeps its reasoning. Reasoning summaries stream into the status area while the model thinks. A model switch never replays another model's reasoning.

Environment variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `AMNESS_MODEL`, `TAVILY_API_KEY` (better web search for the research agent), `AMNESS_HOME` (config directory, default `~/.amness`), `NO_COLOR`.

## Headless and CI

```bash
amness run --verify "npm test" --json "fix the failing test"      # one-shot, no TTY needed
```

| Flag | |
|---|---|
| `--cwd <dir>` | workspace (default `.`) |
| `--verify <cmd>` | must exit 0 before the agent may finish |
| `--provider`, `--model`, `--base-url`, `--effort`, `--api` | model selection |
| `--yes` | auto-approve risky commands (default: they are denied) |
| `--json` | one JSON event per line on stdout, then a final `{"kind":"result"}` line |
| `--bundle <file>` / `--export <file>` | continue from / write a portable session bundle |
| `--live [port]` | serve the browser live view |
| `--max-tokens <n>` · `--no-memory` | hard token cap · disable memory |

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

Building blocks: `createHarness` (the loop: validation and repair, finish gate, nudges, loop guard, budgets, steering, checkpoint/resume, `extract()` for validated JSON), `Registry` (tools that change mid-run, deferred tool search, MCP via `loadMcp`), `createCodeAgent`, `createDeepAgent` (planning, parallel context-isolated subagents, web search, citation checking), `MemoryStore`, `evaluate`/`codeVariants` (A/B your guards on held-out checks), and the `openai`/`anthropic` model adapters. A model is just `(messages, tools, opts) => Promise<Message>`, so adding a provider is one function.

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

Because the CLI relies on Node's built-in TypeScript support, amness is not published to npm yet; use it from a clone or `npm link`.

## Architecture

```
cli/amness.ts            entry: chat TUI (default), headless `run`, classic `menu`, `demo`
cli/tui/                 the chat UI: screen renderer, editor, key parser, markdown, overlays, commands, theme
src/harness.ts           agent loop and guards            src/openai.ts     Responses + Chat Completions adapter
src/code.ts              coding agent and tools           src/anthropic.ts  Claude adapter
src/deep.ts, web.ts      research agent                   src/memory.ts     notes, handoffs
src/dynamic.ts           live tool registry, MCP          src/bundle.ts     portable sessions
src/evals.ts             A/B evals with held-out checks   src/live.ts       browser live view (127.0.0.1 only)
```

The runtime has no dependencies. The UI draws a small live region at the bottom of the terminal and prints everything else into normal scrollback, like most modern terminal agents, so there is no alternate screen except for the transcript pager.

## Safety and privacy

- **Data leaves your machine only to the provider you configure** (plus web search/fetch if you use the research agent). There is no telemetry. OpenAI requests are stateless by default (`store: false`).
- **Keys** come from environment variables or `~/.amness/config.json` (mode 600). They are never written into a project.
- **File tools are confined to the workspace** and enforce read-before-edit. **Shell commands are not sandboxed:** `sh` can do whatever your user can. The permission prompts are the safeguard, so read them, and prefer `plan` or `default` mode on code you do not trust.
- **Treat project-supplied context as untrusted.** Memory notes, `.amness/commands/` and `AGENTS.md` from a repository you cloned can contain prompt injection. Notes are presented to the model as hints to verify, and risky actions still need your approval.
- The browser live view listens on `127.0.0.1` only, rejects foreign `Host` headers, and renders diffs as text, never HTML.
- `.amness/` holds per-project state (chats, checkpoints, handoffs, memory). Add it to your `.gitignore`, except `memory/` and `commands/` if you want to share those.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit over src, cli, tests and examples
npm test               # unit and in-process UI tests (~160), run on Node's built-in test runner
npm run test:pty       # the real binary in a pseudo-terminal against a mock streaming server (needs python3)
```

The UI tests drive the real `App` with simulated keystrokes and read the screen back through a small VT100 emulator (`test/helpers/vterm.ts`), so layout, cursor placement and redraw behaviour are checked, not just strings. Model providers are exercised against scripted and mock HTTP servers, including one that reproduces OpenAI's "tools with reasoning" 400. Contributions are welcome: please keep `npm run typecheck` and `npm test` green.

## Limitations

- Developed and tested on macOS and Linux terminals; Windows is untested.
- Automated tests use scripted models and mock servers. Behaviour against live provider APIs has been checked by hand only, and provider APIs change; if one breaks, open an issue with the error text.
- Cost figures are estimates (no invoices, cached input assumed at about 10% of the input price, and some models have no price listed).
- Not on npm yet (see above), and the Docker image is untested.
- Tool-calling quality with small local models varies widely.

## License

[MIT](LICENSE) © 2026 amirhossein jofreh
