# Using the chat

The chat is where you talk to Amness: you type a request, the agent reads and changes your code, and you approve or reject each risky step.

In this page you will learn:

- how to start the chat and choose the full-screen or the inline interface
- which keys and prefixes (`@`, `/`, `!`, `#`) you can type in the input box
- how permission modes decide when Amness asks you
- what every slash command does

If you are new, read [Getting started](getting-started.md) first.

## Start the chat

**What it is.** `amness` opens a chat in your terminal. It needs an interactive terminal. For scripts, use [headless mode](headless.md).

**Why you would use it.** You see every step the agent takes, and you decide which changes are allowed.

**How to start.**

1. Go to your project folder.

   ```bash
   cd ~/your-project
   ```

2. Start the chat.

   ```bash
   amness
   ```

Other ways to start:

| Command | What it does |
|---|---|
| `amness "fix the failing test"` | Starts with a first request. |
| `amness -c` | Continues the most recent conversation in this folder. |
| `amness --resume <id>` | Continues a specific conversation. |
| `amness --worktree [name]` | Works in a new git worktree on its own branch. Your main checkout stays untouched. It needs a git repository with at least one commit. |
| `amness --inline` or `amness --full` | Chooses the interface. |
| `amness menu` | Opens the classic menu (demo, evals, research, memory, settings). |
| `amness demo` | A guided demo that needs no API key. |

If you have no key yet, the first start asks you to pick a provider and paste a key. See [Providers and models](providers.md).

**Limits and common problems.**

- If the terminal is smaller than 60 columns or 14 rows, or if `TERM=dumb`, Amness uses the inline interface.
- `amness` in a pipe or a script stops with exit code 2 and tells you to use `amness run`.

**Related pages.** [Getting started](getting-started.md), [Headless and CI](headless.md).

## Read the full-screen interface

**What it is.** The default interface has a header (project, branch, model, mode), a scrollable transcript made of cards, a session sidebar, an input panel and a status line.

**Why you would use it.** It shows what the agent is doing while it works, and it keeps long output short.

- **Collapsed reads.** A run of reads and searches becomes one row, for example "Explored · 3 files read · 2 searches". Click it to open it. Edits, commands and failures always get their own card. Long diffs show the first 16 rows, and you click to see the rest.
- **Cards.** Your prompts, the assistant replies (with code blocks that have a copy button), tool cards with a status chip, and diffs with line numbers and word-level marks. Wide terminals show a split view.
- **Live run view.** The status line says what the agent does now, for example "Reading src/app.ts" or "Waiting for you". It also shows elapsed time, tokens and the step counter. The sidebar has a RUN panel with the think, act and verify steps, running tools and the last finished actions.
- **Sidebar** (`Ctrl+B`). It shows the session, a context gauge, token use, todos, changed files and the workspace. The *context* is the text the model can read at one time.
- **Modals.** Windows for approvals (with the diff, command or plan), the command palette (`Ctrl+P`), pickers and help.

![The full-screen chat with cards, a diff, the sidebar and the input panel](images/chat.png)

**Copy text.** Drag to select and copy, in the transcript, the sidebar or a modal. A double-click copies a word and a triple-click copies a line. `/copy` copies the last reply, `/copy code` copies its last code block, and `/copy all` copies the whole conversation. Copy uses the system clipboard and OSC 52, so it can also work over SSH in terminals that support it. To use your terminal's own selection, hold **Shift** (**Option** in iTerm2) while you drag, or run `/mouse off`.

**Mouse.** You can scroll with the wheel, click a card to open or close it, click the model or mode chips in the header, and click suggestions and modal options. A "Jump to bottom" pill and a sticky prompt appear when you scroll up.

**Themes.** `aurora` (default), `tokyo-night`, `catppuccin`, `gruvbox`, `nord`, `daylight` (light) and `terminal` (transparent). `/theme` shows a live preview, and `Ctrl+T` goes to the next theme. Amness uses truecolor and falls back to 256 or 16 colours.

**Limits and common problems.**

- The sidebar, `/theme`, `/details`, `/diffmode` and `/mouse` work only in the full-screen interface. In inline mode they tell you to run `/ui full`.

## Use the inline interface

**What it is.** The inline interface keeps one conversation and a pinned input box. Finished output goes into your normal terminal scrollback.

**Why you would use it.** Native scrolling, selection and copy keep working. It is also the fallback for small terminals.

**How to use it.** Use any one of these:

```bash
amness --inline
```

- Set `ui: "inline"` in `~/.amness/config.json`.
- Set the environment variable `AMNESS_UI=inline`.
- Type `/ui inline` in the chat. `/ui full` goes back.

**What you see.** Each tool call is one line, for example `● Read(src/a.ts)`, with a short result. `Ctrl+O` shows everything. Each edit shows a diff with line numbers. A live todo list, a status line (elapsed time and tokens) and a footer (permission mode, git branch, model, context gauge, estimated cost) stay visible. Tool bullets have a colour for each kind and turn red when the tool fails. With `NO_COLOR=1`, or when the output is piped, Amness uses plain text.

## Type in the input box

**What it is.** The input box accepts plain requests and four special prefixes.

| You type | What happens |
|---|---|
| `Enter` | Sends the message. While the agent works, the message waits in a queue and goes to the agent between steps. |
| `\` then `Enter`, `Alt+Enter`, or `Ctrl+J` | Adds a new line. |
| Paste | A multi-line paste is one input. A large paste becomes `[Pasted text #1 +40 lines]` and expands when you send. |
| `@path` | Mentions a file. A fuzzy popup helps you choose it, and the file contents are attached. |
| `/` | Opens the command popup. You can also search by alias. |
| `!cmd` | Runs a shell command now. Its output is added to the context for your next message. |
| `#note` | Saves a memory note. |
| `Ctrl+P` or `Alt+M` | Opens the command palette or the model picker. |
| `Shift+Tab` | Goes to the next permission mode. |
| `Esc` | Interrupts the agent at a safe point, or closes a popup. Pressing `Esc` twice when the box is empty opens rewind. Pressing it twice when the box has text clears the box. |
| `Ctrl+C` | Interrupts the agent. If the agent is idle, it clears the input. If the input is empty, press it twice to exit. |
| `Ctrl+D` | Exits when the input is empty. |
| `Ctrl+O` | Opens or closes all tool details (in inline mode, a scrollable transcript). |
| `Ctrl+L` | Redraws the screen. |
| `?` | Shows the shortcuts (when the input is empty). |
| `Ctrl+B`, `Ctrl+T` | Full-screen only: toggle the sidebar, change the theme. |
| `PgUp`, `PgDn`, `Ctrl+Home`, `Ctrl+End` | Scroll the transcript, jump to the end. |

**Example.**

```text
❯ explain what @src/index.ts exports
```

The file is attached to your message. In the transcript you see a note such as "attached src/index.ts (120 lines)". The count is an example.

**Limits and common problems.**

- A slash command other than the live ones (for example `/help`, `/diff`, `/tokens`, `/todos`, `/loop`, `/copy`) must wait: while the agent works, Amness says "finish or interrupt (esc) before running commands".
- `@` mentions attach at most 40,000 characters of file text.
- `!cmd` stops after 120 seconds.

## Add images

**What it is.** You can show the model a picture by mentioning it, for example `@screenshot.png`.

**Why you would use it.** The model can read an error screenshot or a design.

**How to use it.**

1. Choose a model that accepts images.
2. Put the picture in your project.
3. Type its path with `@` in your message.

```text
❯ the button in @screenshot.png looks wrong, fix the CSS
```

**Limits and common problems.**

- Allowed types: png, jpg, gif and webp. The limit is 5 MB for each image and 4 images in each message.
- Amness checks the model name to see if it accepts images. If it does not, Amness shows a note and does not send the image. For local models this is a guess from the model name.
- Images stay in the conversation. Amness sends them again with every later request, and you pay for them each time. Start a new conversation with `/clear` when you no longer need them.
- Pasting an image from the clipboard is not supported.
- Image input is tested at the wire-format level. It is not tried on live vision models yet.

**Related pages.** [Features: Image input](features.md#image-input).

## Choose a permission mode

**What it is.** The permission mode decides when Amness asks before it acts. Press `Shift+Tab` or type `/mode` to change it.

**Why you would use it.** You can be strict on code you do not trust and fast on code you do.

| Mode | What happens |
|---|---|
| `default` | Asks before edits (it shows the diff) and before non-trivial shell commands. Read-only commands such as `ls`, `git status` and `grep` never ask. |
| `acceptEdits` | Edits apply without asking. Shell commands still ask. |
| `plan` | Read-only. The agent looks at the code, then shows a plan. You approve the plan before it can change anything. |
| `yolo` | Stops asking for edits and ordinary shell commands. |

**How to answer a question.** When Amness asks, you see the diff or the command and a list of choices. The choices include "Yes", "Yes, and accept all edits this session" (for edits), "Yes, and don't ask again for `npm test`" (for the session) and, for simple commands, "always allow" (this saves a rule in `.amness/permissions.json`). The last choice lets you tell the agent what to do instead.

![An edit waiting for approval, with the diff](images/approval.png)

**Limits and common problems.**

- A *safety floor* applies in every mode, including `yolo`. Amness refuses catastrophic deletes, force-push to main, and edits to `.git` or the rule files. `curl | sh` and force-pushes still ask.
- Shell commands are **not sandboxed** unless you turn the sandbox on with `/sandbox workspace`. It works on macOS and on Linux with bubblewrap. **Windows has no OS sandbox.** In `yolo` mode, use a container or a throwaway checkout with your work committed.
- Rule details are in [Safety and privacy](safety.md) and [Features: Permission rules and the safety floor](features.md#permission-rules-and-the-safety-floor).

## Undo and go back

**What it is.** `/undo` reverts the last turn: the files and the conversation. `/rewind` (or `Esc Esc` on an empty input) lets you pick an earlier turn. `/branch` forks the conversation.

**Why you would use it.** You can try a risky idea and return to a known state.

**How to use it.**

1. Type `/undo` to revert the last turn.
2. Type `/rewind` to choose an earlier turn.
3. Type `/diff` to review all changes of the session.

**Example.** After `/undo` you see a line such as `rewound the conversation to before turn 3 · restored 2 file(s), removed 0`. The numbers depend on your session.

**Limits and common problems.**

- Amness also tries to undo changes made by shell commands. If it cannot, it says so, and it lists commands whose effects cannot be taken back.
- `/branch [n]` keeps the original conversation. It restores files to the state after turn n. `/branches` switches between branches. Switching only changes the conversation. The files stay as they are now. Use `/rewind` or git if the branch needs other files.

**Related pages.** [Features: Undoing what commands did](features.md#undoing-what-commands-did), [Features: Branches, review and pull requests](features.md#branches-review-and-pull-requests).

## Slash commands

Type `/` in the input box to see the popup. It lists **every** command, grouped under titles: Conversation, Model & keys, Safety, Quality, Project, Extend and Interface. Your own and plugin commands go under Custom.

- Move with `↑` and `↓`. `PgUp` and `PgDn` jump eight at a time. The top of the box shows where you are, for example `12/60 ↓`.
- Keep typing to filter. The titles disappear and the best match comes first.
- `Tab` or `Enter` picks the command. `Esc` closes the popup.

`/help` lists the commands in the chat.

### Models and providers

| Command | What it does |
|---|---|
| `/model [id]` | Switches the model. Without an id, it opens a picker. |
| `/provider` | Switches the provider (OpenAI, Claude, OpenRouter, Ollama, custom). The list shows `●` for providers that are connected and `○` for those that are not. Each provider uses its own saved key. |
| `/connect` (alias `/keys`) | Opens the key manager. See which providers are connected, add a key for any of them, replace or remove one, or switch to it. Add as many as you want. |
| `/effort [level]` | Sets the reasoning effort. Levels depend on the model. `default` lets the model decide. |
| `/api [auto\|responses\|chat]` | Chooses the OpenAI wire API. It does not apply to Claude. |
| `/models [role model]` | Uses another model for `explore`, `compact`, `review` or `cheap`. `/models fallback <model>` sets a model for when the main one is overloaded or not reachable. Use `off` to clear a role. |
| `/router [on\|off]` | Sends read-only exploration steps to the `cheap` model when this pays off. You must set a cheap model first with `/models cheap <id>`. |
| `/keepwarm [on\|off]` | Keeps the Claude prompt cache alive while you are away. It affects Claude only. |

### Safety and permissions

| Command | What it does |
|---|---|
| `/mode [mode]` | Sets the permission mode. |
| `/plan` | Enters plan mode (read-only). |
| `/permissions [allow\|ask\|deny <rule>]` | Lists rules, or adds one to `.amness/permissions.json`. Example: `/permissions allow sh(npm test*)`. |
| `/policy` | Shows why recent actions were allowed, asked or refused. |
| `/sandbox [off\|workspace\|strict]` | Sets the OS sandbox for shell commands. `workspace` lets commands write only in the project and in temp folders. `strict` also blocks the network. |
| `/approver [on\|off]` | A second model approves clearly safe risky calls before it asks you. It never overrides the safety floor. It costs one short model call for each risky action. |
| `/reviewer [on\|off]` | An independent reviewer writes acceptance criteria first and checks the work before it is accepted. It costs about 2 to 4 more model calls for each task. |
| `/hooks` | Shows the lifecycle hooks in effect. |

### Checks and proof

| Command | What it does |
|---|---|
| `/verify [cmd\|off]` | Sets the command that must pass before the agent can finish. Without an argument, it shows the current command. Amness remembers it for each folder. |
| `/check [cmd\|off]` | Sets a fast command that runs after every edit. Only failures go to the model. |
| `/shell [name\|auto]` | which shell runs the agent's commands: bash, zsh, sh, pwsh, powershell, cmd, or auto (bash, then zsh, then sh on macOS and Linux; Git bash, then pwsh, then Windows PowerShell, then cmd on Windows). The model is told which one it has, and the safety floor knows PowerShell and cmd dangers |
| `/lsp [on\|off]` | Adds language-server errors to edit results. You must install `typescript-language-server`, `pyright`, `gopls` or `rust-analyzer`. |

When you start the chat, Amness picks a first `/verify` command for you if it can: `npm test` (for a `package.json` with a test script), `cargo test`, `go test ./...` or `pytest -q`. Type `/status` to see which command is set.

### Conversation and context

| Command | What it does |
|---|---|
| `/clear` (alias `/new`) | Starts a new conversation. The old one is saved. |
| `/compact` | Summarises the conversation to free context. |
| `/resume` (alias `/sessions`) | Continues an earlier conversation. |
| `/undo`, `/rewind`, `/diff` | Revert the last turn, go back to a turn, review all changes. |
| `/branch [n]`, `/branches` | Fork the conversation after turn n, or switch between branches. |
| `/export [file]`, `/import <file>` | Write a portable session bundle, or continue from one. |
| `/copy [code\|all]` | Copies the last reply, its last code block, or the conversation. |

### Information

| Command | What it does |
|---|---|
| `/help` (alias `/?`), `/status`, `/tools`, `/todos` | Help, session facts, tools the agent can use, the agent's checklist. |
| `/tokens` (alias `/cost`) | The context gauge, what fills it, tokens, cache hits and estimated cost. |
| `/loop` (alias `/trace`) | A step-by-step trace of the agent loop: each model turn, its tools and times, and any guard that fired. |
| `/budget [tokens]` | Shows or sets the token cap for each turn (default 300,000). Cached input counts as a tenth. You can write `500k` or `1m`. The minimum is 10,000. |
| `/procs [stop <id>]` | Lists background processes the agent started, or stops one. |
| `/profile` | Shows the harness settings that apply to this model. |
| `/report [case <name>]` | Shows repeated problems in your traces. `case <name>` turns your last request into an eval task. |
| `/plugins`, `/agents`, `/skills` | Lists loaded plugins, custom subagents and skills. |
| `/reload-plugins` | Loads the plugin files again after you edited one. Project plugins that you did not approve are skipped. See [Plugins](plugins.md). |
| `/strategy [name\|off]` | Chooses a loop strategy: `plan-first` or `explore-then-act`. Without an argument it shows the current one. See [Plugins](plugins.md#change-the-loop-with-a-strategy). |

![The /loop view: each model turn with its tools and timings](images/loop.png)

### Memory and project files

| Command | What it does |
|---|---|
| `/memory` | Lists notes. Subcommands: `add <text>`, `forget <name>`, `stale`, `prune`, `consolidate`, `graph`, `embeddings on\|off`. |
| `/init` | Asks the agent to write an `AGENTS.md` file for the repository. |
| `#note` | Saves a note without a command. See the memory section below. |

### Git and review

| Command | What it does |
|---|---|
| `/review [base]` | A read-only review of your changes against the base branch. |
| `/pr [draft]` | Drafts a pull request, shows it, and creates it with `gh` only after you confirm. It needs the GitHub CLI. |

### Tools and sharing

| Command | What it does |
|---|---|
| `/mcp <command>`, `/mcp list`, `/mcp off` | Attaches an MCP server (a program that gives the agent more tools), lists attached servers, or detaches them. |
| `/live` | Opens the browser live view. Diffs stream there. |

### Appearance and interface

| Command | What it does |
|---|---|
| `/theme [name]` | Changes the colour theme with a live preview. |
| `/sidebar` (alias `/side`) | Shows or hides the side panel. |
| `/details` | Opens or closes all tool output. |
| `/diffmode [auto\|stacked\|split]` | Chooses the diff layout. |
| `/mouse [on\|off]` | Turns the mouse on or off. Off restores native text selection. |
| `/ui [full\|inline]` | Switches the interface. |
| `/exit` (alias `/quit`) | Leaves the chat. |

**Your own commands.** A file `audit.md` in `.amness/commands/` (or `~/.amness/commands/`) creates `/audit`. See [Features: Your own commands](features.md#your-own-commands).

## Save notes and keep long sessions going

**What it is.** Memory notes are plain markdown files in `.amness/memory` (this project) and `~/.amness/memory` (all projects). The agent saves and recalls them. When a session gets long, Amness hands the work over to a short summary, and `/compact` does the same on request. `/export` writes a bundle that you can continue with another model.

**How to save a note.**

1. Type `#` and your note.

   ```text
   # run tests with npm test, never with npx jest
   ```

2. Check the result. You see "remembered" and the note name.
3. Type `/memory` to list your notes.

Notes are ranked, merged and removed in a way you can reverse. Details: [Features: Memory](features.md#memory) and [The agent loop](agent-loop.md).

## Options without a command

Put these in `~/.amness/config.json`. See [Budgets and subagents](budgets.md).

| Key | What it does |
|---|---|
| `"taskBudget": 150000` | Claude's own budget countdown. The minimum is 20,000. It works on supported models only. |
| `"compactAt": 150000` | OpenAI Responses server-side compaction. |
| `"maxConcurrent": 4` | The most model requests in flight at once (lead agent and subagents). Lower it if your provider returns rate-limit errors often. See [Rate limits](budgets.md#rate-limits-requests-and-tokens-per-minute). |

## Pictures and other options

- **Images:** see "Add images" above.
- **Other commands:** `amness tune`, `amness schedule`, `amness acp` and the headless flags are in [Features](features.md) and [Headless and CI](headless.md).

## Next steps

- [Getting started](getting-started.md): a first session, step by step.
- [Providers and models](providers.md): use OpenAI, Claude or a local model.
- [Headless and CI](headless.md): run Amness without a terminal.
- [Safety and privacy](safety.md): what Amness can and cannot protect.
- [Features in depth](features.md): everything else, one section each.
