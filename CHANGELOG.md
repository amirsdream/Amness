# Changelog

## 0.5.2 (2026-11-08)

- **Clearer questions for risky commands.** Before, the approval showed category words such as "recursive/forced delete" or "dangerous system command", sometimes two "⚠" lines that said nearly the same thing, and the desktop app showed the warning twice. Now one line says what this command will do ("Deletes build and everything in it", "Force-pushes feature to origin, replacing the commits there", "Installs left-pad from the internet"), marked ▲ (high) or ● (caution). A second line says whether `/undo` can take it back: yes, partly (not files git ignores, not git history), or no (it reaches another machine, or the folder has no git). The terminal (inline and full screen) and the desktop app show the same two lines; the full-screen view used to leave out "cannot be undone". `sh_start` asks the same way.

## 0.5.1 (2026-11-08)

**0.5.0 was not published to npm** (its release check failed), so 0.5.1 is the first version with everything listed under 0.5.0 below.

- **Settings: a refused change is reported.** If a setting's command refuses a value (for example the sandbox on a machine without one), Apply in Preferences, `/settings` and `/set` now say it was not applied, with the reason. Before, they counted it as applied.

## 0.5.0 (2026-11-08)

- **Preferences: Apply, Revert, and up-to-date tabs.** In the desktop app, switching tabs in Preferences showed the values from when it opened, not what you had just changed. Fixed. Every change is now a draft: appearance previews at once, agent settings run on **Apply**, **Revert** undoes everything, and closing with changes left asks first. Changed settings and tabs get a dot.
- **One settings list for both apps.** Desktop Preferences and the new terminal `/settings` page come from one shared list, so they show the same settings and change them with the same code. `/settings` has the same groups and the same Apply. `/set <name> <value>` changes one setting by name.
- **New settings:** Folders and trust (folders outside the project, trusted folders), Context and limits (context window, requests at once, Claude task budget), Search and memory (Tavily key, semantic memory, memory notes), your saved servers in Provider, and permission rules.
- **Saved servers.** Amness now remembers each Ollama or custom server you set up: its address, model and its own key. `/provider` lists them by name, and picking one switches without asking anything. **+ Ollama server…** and **+ Custom OpenAI-compatible server…** set up a new one: the address, an optional key, the model (from the server's own `/v1/models` list) and a name. `/connect` uses, re-keys, edits or forgets a saved server. `/model` on a saved server is remembered with it. `amness run --server <name>` uses one. Each server has its own key slot, so a token is never sent to another server. Your current custom or Ollama setup is saved as a server on the first start. Works the same in the terminal and in the desktop app. Saved servers also keep their place in the list.

## 0.4.2 (2026-11-08)

- **"hi" gets a hello, not a project survey.** In a new session, a greeting made the agent list files and read the project. Three things caused it: the first message carried the project guidance (`AGENTS.md`), skills and memory notes; the nudge guard read "I'll be glad to help" as a stalled task and told the model to use a tool; and the prompts said nothing about greetings. Now small talk ("hi", "thanks", "ok", "how are you") is sent as it is and answered in words. The guidance and notes come with your first real request, so saying hi first loses nothing. The nudge also leaves alone a reply that asks you a question.

## 0.4.1 (2026-11-08)

- **Trust a folder first, as in Claude Code.** The first time you start Amness in a folder, it asks **Do you trust the files in this folder?** Nothing runs before you answer, not even a task given on the command line. **Yes** is saved in `~/.amness/state.json` and covers the folders inside. **No** exits (code 3); in the desktop app, it goes back to the project you had open. In your home folder, Amness warns you. Project hooks, plugins and permission rules are still asked about separately. See [Safety](docs/safety.md#trust-a-folder-before-amness-works-in-it).

## 0.4.0 (2026-11-08)

- **Allow a folder outside the project, as in Claude Code.** Before, the file tools refused any path outside the project. Now Amness asks first (terminal and desktop): **Yes, for this session**, **Yes, and always for this project** or **No**. One yes covers the whole folder. `/dirs` lists, adds (`/dirs add <path>`, or `/add-dir <path>`) and removes allowed folders. `amness run --add-dir <path>` does the same for a headless run. Folders allowed for good are saved in `~/.amness/state.json`, never in the project, so a cloned repository cannot grant itself access. Edits there still ask first in Ask mode. See [Safety](docs/safety.md#allow-a-folder-outside-the-project).

## 0.3.4 (2026-11-08)

- **The conversation list no longer reorders when you open a conversation.** Opening another conversation saved the one you left and moved it to the top, although nothing in it changed. Now a conversation moves only when its messages change; opening it, leaving it, renaming it or changing a setting keeps its place. This applies to the desktop list and to `/resume` in the terminal.

## 0.3.3 (2026-11-08)

- **Desktop: tooltips.** Hovering a button, a menu item (model menu, project menu), a panel tile or a section header shows what it does, its shortcut as a key chip (`⌘K` on a Mac, `Ctrl+K` elsewhere) and the command it runs. One styled tooltip replaces the slow system one: it appears after a short pause, at once when you move to the next button, beside the item in menus, stays put while the panel redraws, and shows on keyboard focus too.
- **Desktop: the context chart shows each request.** Hover a bar in the panel's Context chart for that request: tokens sent and the share of the window, cached tokens, tokens received and reasoning, the cost estimate, which step or subagent sent it, and when. The cached part of each bar is drawn lighter. Each request is now kept in the conversation (`usage.requests`).
- **Desktop: the panel no longer blinks while Amness works.** It updates only what changed instead of redrawing everything, so hovering the agent loop is steady. Loop lines no longer have their own tooltip.

## 0.3.2 (2026-11-08)

- **A key for a local server:** Ollama and custom OpenAI-compatible servers can now have an API key or token, for a server that checks one (vLLM `--api-key`, `llama-server --api-key`, llama.cpp behind nginx, LM Studio with authentication). `/provider` asks for it after the base URL (Enter skips), `/connect` adds, replaces or removes it, the first setup asks too, and a 401 from the server asks for a key and sends the message again. The key is optional (Enter skips it) and works the same in the desktop app. With no key, requests now carry no `Authorization` header instead of an empty `Bearer`. Before, `/connect` said a local provider "needs no key" and the only way was `OPENAI_API_KEY`.

## 0.3.1 (2026-11-08)

- **Windows: skill files are listed with `/`.** A skill's file list showed paths such as `scripts\run.sh` on Windows; it now shows `scripts/run.sh` on every system, as on macOS and Linux.
- **Tests:** the `/undo` snapshot test no longer fails at random when it checks a file in the moment the undo is putting it back.

## 0.3.0 (2026-11-07)

**Update from 0.2.0:** in the 0.2.0 desktop app, clicking an item in a list (the model button, `/resume`, `/theme`…) often did nothing; the keyboard worked. This release fixes it (see below).

- **Edit an earlier message:** `/edit [n]` (or **✎ Edit** on your message in the desktop app) changes a message you sent and sends it again. Amness goes back to before it, files included, and keeps the old version as a branch.
- **Edit the plan and the todo list:** when Amness shows a plan, **Yes, after I edit the plan** opens it in your editor (desktop: an editor window) and Amness follows your version. `/todos edit` changes its checklist.
- **Harness settings:** `/harness` (desktop: Preferences → Harness) switches each guard of the agent loop on or off and sets the step limit, the no-progress limit and the context budget. Saved in the config file.

- **Desktop: a slimmer conversation list.** One line per conversation with a short time (`4m`, `3h`, `Tue`), grouped by recency (Today, Yesterday, Previous 7 days…). Older groups are folded to a count, an open group shows 5 and "Show N more", and what you fold is remembered. The open one has a dot that pulses while it works. Hovering shows the last messages in a card beside the list. The sidebar is a little narrower.
- **Desktop: remembered layout choices with spaces in their names** (folded panel sections such as "Last run", conversation groups) were not saved; they are now.
- **Desktop: clicking an item in a picker chooses it.** In 0.2.0, hovering a list item rebuilt the list, so a mouse click was often lost: the model button opened the model list, but clicking a model did not change it (the keyboard worked). This affected every picker in the desktop app (`/model`, `/resume`, `/theme`, `/mode`…). The window checks now hover like a mouse.

## 0.2.0 (2026-11-05)

**Upgrade note:** Electron is now a dependency, for the desktop app. Installing stays small: Electron downloads its program (about 100 MB) only the first time you start `amness-desktop`, so the first start takes a little longer. If you never use the desktop app, nothing is downloaded. Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` to prevent the download; `amness-desktop` then opens in a Chrome/Edge window or your browser.

- **Desktop app:** `amness-desktop` (or `amness desktop`) opens Amness in a window. The window runs the terminal app's own `App` (new `ui: "remote"` mode), so every command, dialog, approval, plugin, MCP server, hook, memory and budget works the same in both, and new features reach both. It adds: all commands with the terminal's completion and a command palette, command output in colour, expandable tool cards with input and output, live thinking, a live status line (time, tokens, step, reasoning, queue), the full side panel including the agent loop, conversations with search and preview, a project file tree with a live file view, project switching, and desktop notifications. The agent runs in Node; Electron (now a dependency, pinned to 44.9.2) only draws the window, on a token-protected 127.0.0.1 server. `npm run test:desktop-ui` checks the real window. See [docs/desktop.md](docs/desktop.md).
- **Desktop layout:** thinking shows in the conversation where it happens, open while it forms and folded to one line once the next step starts. The step happening now is open and earlier steps fold; a finished turn folds its work into one "Worked …" line with changed-file chips, and the answer stays in full. Steps sit on a timeline. The panel has four tiles (context, cost, tokens, cache) and sections that fold. Below 1280/1000 pixels the panel and the sidebar become drawers. The run panel opens the step happening now, in the terminal sidebar too.
- **Desktop preferences and icon:** a Preferences window (⚙, `⌘,`) for appearance (theme, accent, interface and chat text size, code font, density, motion), chat behaviour and the agent settings (model, effort, budget, roles, sandbox, verify, check, reviewers, shell, strategy). Agent settings run the terminal's own commands. Preferences are saved in the config file; before this, the window's choices (folded sections, panels) were lost at every restart because the page's address changes each launch. The app has its own icon in the dock, taskbar and window.
- **Shared side panel:** the sidebar and loop data are computed once (`cli/tui/panel.ts`) for the terminal and the desktop.

- **Input:** `Ctrl+R` searches your earlier messages. `Ctrl+Z`/`Ctrl+Y` undo and redo typing. `Ctrl+G` writes the message in `$VISUAL`/`$EDITOR`. `Ctrl+V` pastes a clipboard image. Pickers now match fuzzily ("gsol" finds "gpt-6.1-sol").
- **Find and navigate (full screen):** `Ctrl+F` finds text in the conversation with live highlights. `Alt+↑`/`Alt+↓` jump between your messages. Clicking a file path in a reply (`src/app.ts:12`) opens it in your editor at that line.
- **Stay informed:** a desktop notification when a long turn ends or approval is needed while the terminal is in the background (`/notify`). The sidebar shows the last turn's cost (subagents included) and an AGENTS panel with each working subagent's task, current step and time. The "Worked for" line shows the turn's cost.
- **Sessions and vim:** `/rename` names a conversation. `/resume` previews each conversation, and `--resume <name>` finds one by name. `/vim` adds vim-style editing to the input box.
- **Emoji:** joined emoji (👨‍👩‍👧), skin tones, flags, ✅ and newer emoji are measured as the terminal draws them, so borders and the cursor no longer shift.

- **Less repeated file text:** when the agent reads a file again in a different line range, lines it already received (and that are still in the conversation, in a file that has not changed) are replaced by one marker line, so each line is sent once. On 632 recorded reads about 30% of the text was lines already sent. Switch off with `off: ["readdelta"]` (ablation variant `full-readdelta`).
- **Expired key:** when a provider rejects your API key (a 401, or a message that the key is invalid, expired or revoked), the chat asks for a new key, saves it, and sends your message again. A key from an environment variable is not replaced; you are told to update it.
- **DeepSeek cache:** `prompt_cache_hit_tokens` is now read as cached tokens, so the cache figure and the cost are right on DeepSeek.
- **`amness replay` shows an input-cost estimate** (requests, tokens, share shared with the request before, cost at 10% and 50% cached price), so a change to history handling can be compared offline.
- **Library:** `governRewrites` rewrites old messages only where the saving beats the cache it loses (`src/rewrite.ts`). Off by default: on 21 replayed sessions it was neither clearly better nor worse.

## 0.1.7 (2026-11-01)

- **Skills you can see and manage:** `/skills` now shows which skills the model is using (and how often each was used here), and the sidebar has a SKILLS panel with `●` in use, `○` available, `⊘` off. New: `/skills show`, `new`, `add <folder or git URL>` (with a preview and a question first), `remove` (to a trash folder), `on` and `off`, and `amness skills` on the command line. With more than 8 skills, only the 8 that match your message best are listed to the model (4 in a small window), and the rest are counted. `/skills draft` asks the model to write a skill from a finished conversation as a **draft** that only becomes active when you approve it. See [Skills](docs/features.md#skills).
- **Small windows:** the list of left-out tools in the prompt now carries names only (about 250 tokens saved). Tool definitions are also sent shorter (the first sentence of each description, none inside the parameters, and a hand-written short text for `edit_file`); names, types, required lists and enums are unchanged. `amness eval` gets `--context-window` and `--schemas full|compact` to measure the difference.
- **"Read each file" means each file:** when a task asks the agent to read every file, and it tries to finish after opening only some of the files it listed, the finish is refused with the names of the unread files (twice at most). Switch off with `--off coverage`. A local Qwen had described 32 files after reading 3.
- **Tool names:** a call to a tool that does not exist is now answered with the closest real name (`readfile` → `read_file`), so a small model can fix the call in one step.

## 0.1.6 (2026-10-31)

- **Small-window profile:** with a context window of 16,384 tokens or less, Amness sends a much smaller request. A bare "hi" cost 3.4k tokens on a local Qwen (42% of an 8k window); it now costs about 1.3k to 1.5k. The system prompt is a third of the size, the Skills and Memory blocks are compact, and the rarely used tools (memory, skills, subagents, repo map, background shells, patches) stay out of the prompt until the model asks for them with `tool_search`. Nothing changes for large windows.

- **Caching:** four caches that work with any provider. (1) Repeated reads are not run again while nothing changed, and a repeat is answered with a one-line pointer while the first copy is still in the conversation. (2) `amness eval --cache` and `amness run --cache` answer identical model requests from disk, so a rerun costs nothing (trials stay independent). (3) `/plans on` or `--plans` keeps a short plan from each finished task and offers it when a similar task comes in (off until measured). (4) `/cache` shows what was reused, including a vLLM server's prefix-cache hit rate. See [Agent loop](docs/agent-loop.md).

- **Small context windows:** Amness now keeps every request inside the model's context window, so a long session on a small local model (for example a 30B Qwen with an 8k window) no longer dies with "maximum context length". Set the window with `contextWindow` in the config, `AMNESS_CONTEXT_WINDOW`, or `--context-window`; if you set nothing, it is learned from the first overflow error and remembered. As the window fills, old tool output and big tool arguments are shortened first, then a handoff note is written (built from a shrunk copy, with a fallback that needs no model call). The sidebar, footer and `/tokens` show the percentage of this window. `amness run` also gets `--max-steps`. The window is also detected from the server when it reports one (vLLM, LM Studio, llama.cpp, Ollama), so nothing needs to be set. When a long tool result is cut, the marker now says how to read the rest. See [Run a local model](docs/providers.md) and [Agent loop](docs/agent-loop.md).

## 0.1.5 (2026-10-31)

- **Windows colours:** Windows sets neither `TERM` nor `COLORTERM`, so Amness fell back to 16 colours there and the themes looked washed out. Windows Terminal, VS Code and any Windows 10 (build 14931 or newer) console now get full truecolor, like on macOS.
- **Links:** a link in the agent's reply is now clickable in the full-screen view: a click opens it in the browser (http and https only, with a notice of where it goes), a double-click copies it, a wrapped link works as one, and links are underlined. Before, a click did nothing and a double-click copied the whole URL as a word, a triple-click the whole line.

## 0.1.4 (2026-10-31)

- **Docs:** [Agent loop](docs/agent-loop.md) now compares the loop with other tools (gather, act, verify; plan gates; post-edit checks; fixed pipelines), and a wrongly credited claim about a harness-design paper was corrected.
- **Sidebar:** the RUN panel is now a **LOOP** panel. It draws the cycle gather ◉ → act ✎ → verify ✓ and lights the stage that is running (stages are inferred from the tool calls), counts rounds, and lists the latest steps with their stage icons. Harness interventions (nudges, rejections, loop warnings) stay next to their step, click a step to open it, older steps fold when there is little room, and it stays as LAST RUN after the run. `/loop` labels every turn with its stage and counts the rounds. The step limit is shown only when it matters ("of 60" past half, a warning at 80%), instead of a progress bar toward it.

- **Evals:** `--max-cost <dollars>` (optional, off by default) stops starting sessions at an estimated spend; every run prints its estimated cost. `--calibrate` lists each task's baseline pass rate and which to keep. A task's `check` can read the agent's final message (`run.text`), with `solutionSummary` for the selftest.

## 0.1.3 (2026-10-31)

- **Several providers at once:** each provider keeps its own saved key. `/connect` (alias `/keys`) shows which providers are connected and lets you add, replace or remove a key; `/provider` marks connected ones and uses the saved key. `OPENROUTER_API_KEY` is read for OpenRouter. A key from an older version moves to the provider that was active.
- **Argument completion:** after a command and a space, the popup lists what it accepts (`/mode`, `/model`, `/theme`, `/sandbox`, on/off switches, turns for `/branch` and more). `/model` also lists the models your provider offers, and the `/model` picker includes them.
- **Tool output:** the most recent tool call stays open in the full-screen view (a 20-line preview), older ones fold, and the new `/output` shows a call's full output in a pager.
- **Slash menu:** `/` now lists every command under category titles, scrolls with ↑ ↓ and PgUp/PgDn, and shows your position.

## 0.1.2 (2026-10-31)

First public version. (0.1.0 and 0.1.1 were staged on npm but never released; they lacked parts of the key store and the bundled Claude SDK below.) A terminal coding agent for OpenAI, Claude and local models, with a full-screen and an inline interface, headless mode, evals, memory, MCP and a library API.

- **Loop and guards:** claims ledger and audit of the finish summary, stagnation detection from test/build output, optional independent reviewer, loop and cycle detection, budget notes and a final report before the token cap, read-only streak check.
- **Safety:** permission rules with a floor that holds in yolo, OS sandbox (macOS Seatbelt, Linux bubblewrap), taint check for commands copied from untrusted text, secrets redaction, shell undo through git snapshots, optional approval reviewer.
- **Tools and context:** apply_patch and multi-edit, background processes, code index (`repo_map`, `find_refs`, `impact`), skills, custom subagents with worktree isolation, hooks, MCP, AGENTS.md loading, image input, optional language-server diagnostics.
- **Cost:** staged context trimming that keeps the provider cache valid, optional cache keep-alive, model routing, per-role models, subagent budget slices.
- **Workflow:** git worktree sessions, `/review`, `/pr`, `/branch`, `amness schedule`, `amness acp`, a GitHub Action.
- **Shell and platform:** the shell is detected per OS (bash, zsh, sh, Git bash, pwsh, Windows PowerShell, cmd), the model is told which one it has, PowerShell and cmd get a safety floor, `/shell` shows what was detected, and `!cmd` runs a command directly.
- **Keys:** the API key is saved in the macOS Keychain, the Linux keyring or Windows DPAPI instead of a plain file (plain file with mode 600 only where there is no store). Keys from environment variables are never saved. In Docker or Kubernetes nothing is written to disk, and `*_API_KEY_FILE` reads Docker secrets. An old plain-text key moves over on the next start.
- **Install:** `npm i -g amness` or `npx amness` gives the `amness` binary and the Claude SDK (an optional dependency) (built to `dist`, Node 22.18 or later). Releases are staged by CI and approved by hand.
- **Measurement:** `amness eval` (paired statistics, ablations, SWE-bench-format suites, leak audit), `amness tune`, trace replay, failure mining.

Known limits: newer features are tested with scripted models but not yet measured on real tasks; Windows has no OS sandbox. See ROADMAP.md.
