# Changelog

## Unreleased

- **Several providers at once:** each provider keeps its own saved key. `/connect` (alias `/keys`) shows which providers are connected and lets you add, replace or remove a key; `/provider` marks connected ones and uses the saved key. `OPENROUTER_API_KEY` is read for OpenRouter. A key from an older version moves to the provider that was active.
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
