# Using the chat

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
| `/branch [n]` · `/branches` | fork the conversation after turn n (files are restored to that point; the original is kept), switch between branches (conversation only: files are not swapped back) |
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

**Memory, long sessions and portability.** Plain markdown notes (`.amness/memory`, `~/.amness/memory`) that the agent saves and recalls, ranked, merged and forgotten reversibly; automatic handoff (and `/compact`) keeps long sessions going; `/export` writes a provider-neutral bundle you can continue elsewhere with another model. Details: [Memory](features.md#memory) · [Long sessions](agent-loop.md).
