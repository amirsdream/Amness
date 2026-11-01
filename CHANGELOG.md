# Changelog

## Unreleased

- **Small windows:** the list of left-out tools in the prompt now carries names only (about 250 tokens saved). Tool definitions are also sent shorter (the first sentence of each description, none inside the parameters, and a hand-written short text for `edit_file`); names, types, required lists and enums are unchanged. `amness eval` gets `--context-window` and `--schemas full|compact` to measure the difference.
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
