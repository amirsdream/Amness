# Roadmap: harness gaps to close

Found by comparing Amness with the main coding-agent harnesses and recent papers (see [Sources](#sources)). Work through them in order; tick a box when the item is done **and** its acceptance check passes. Each item gets its own commit, tests, and a README line.

Legend: **P1** do first · **P2** next · **P3** later. Effort: S (hours), M (a day or two), L (several days).

How to use this file: say "do G1" (or "do the next one"), and the item is built, tested, ticked here, and pushed. Add new gaps at the bottom with the next free id.

## Status

| Id | Item | Priority | Effort | Done |
|---|---|---|---|---|
| G1 | Load `AGENTS.md` and friends automatically (fixes a bug) | P1 | S | [ ] |
| G2 | Lifecycle hooks | P1 | S | [ ] |
| G3 | Permission rules and a hard deny floor | P1 | S | [ ] |
| G4 | Background processes | P1 | M | [ ] |
| G5 | Better edit formats (patch, multi-edit, fuzzy fallback) | P1 | M | [ ] |
| G6 | OS-level sandbox for shell commands | P1 | M | [ ] |
| G7 | Skills (`SKILL.md`) | P2 | S–M | [ ] |
| G8 | Custom subagents (and parallel worktree subagents) | P2 | M | [ ] |
| G9 | Model routing (cheap model for exploring and compacting) | P2 | S–M | [ ] |
| G10 | Code index / repo map | P2 | M | [ ] |
| G11 | Language-server diagnostics after edits | P2 | M | [ ] |
| G12 | Tracing (JSONL trace file, OpenTelemetry export, cache-miss cost) | P2 | S–M | [ ] |
| G13 | Git worktrees, `/review`, pull-request helper | P2 | M | [ ] |
| G14 | Better loop detection (cycles, not only exact repeats) | P2 | S | [ ] |
| G15 | Prompt-injection and secrets hardening | P2 | M | [ ] |
| G16 | Editor integration (ACP server, VS Code) | P3 | L | [ ] |
| G17 | Image input (screenshots) | P3 | M | [ ] |
| G18 | Session branching | P3 | M | [ ] |
| G19 | Scheduled and background agents; GitHub Action | P3 | L | [ ] |
| G20 | LLM approval reviewer for risky calls | P3 | M | [ ] |
| G21 | Windows support (tested) and a built, tested Docker image | P3 | M | [ ] |
| G22 | Publish to npm (needs a build step or a bundled runtime) | P3 | M | [ ] |

---

## P1

### G1. Load `AGENTS.md` automatically
**Why.** `/init` writes an `AGENTS.md`, but nothing reads it back, so it only helps if the model happens to open it. Claude Code, Codex, OpenCode and Gemini CLI all load project instruction files at session start, including per-folder ones. The README currently implies we do; fix both.
**Build.** At the start of a conversation, add the contents of `AGENTS.md` from the workspace root, plus `CLAUDE.md` and `GEMINI.md` as fallbacks (first found wins at each level), to the first user message after the memory block. Also pick up the nearest `AGENTS.md` in a subfolder when the agent first reads a file there (append to that tool result, at the end, so the cache prefix is untouched). Cap size (about 8k chars per file) and frame it as project guidance, not commands. Show which files were loaded in `/status`.
**Accept.** A test with a temp repo: the first message carries the root file; a read inside `pkg/` surfaces `pkg/AGENTS.md` once; an over-long file is truncated with a notice; a repo with no such file changes nothing. README no longer overstates.

### G2. Lifecycle hooks
**Why.** Codex and Claude Code share a hook vocabulary (PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop, PreCompact...). Hooks let teams enforce policy and automate (format after edit, block `git push`) without changing the harness.
**Build.** `.amness/hooks.json` (and `~/.amness/hooks.json`): `{ "PreToolUse": [{ "match": "sh", "command": "./scripts/check.sh", "timeout": 10 }] }`. A hook receives the event as JSON on stdin and can exit 0 (allow), exit 2 (block, stderr is shown to the model), or print JSON to rewrite arguments or add context. Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`. Hooks run with a timeout, never see API keys, and a hook crash fails open with a visible warning (configurable to fail closed). Expose in the library as `hooks` on `createHarness`.
**Accept.** Tests: a blocking PreToolUse stops the call and the model sees the reason; PostToolUse output is appended to the result; timeout and crash behaviour; `Stop` hook can reject a finish with feedback; hook config shown in `/status`.

### G3. Permission rules and a hard deny floor
**Why.** Today: a pattern list for risky commands plus per-session "don't ask again". The field has persistent allow/deny rules, and Hermes keeps a policy floor that even YOLO cannot lower. In yolo mode Amness will currently run `rm -rf` unprompted.
**Build.** `.amness/permissions.json`: `{ "allow": ["sh(npm test*)", "edit(src/**)"], "ask": [...], "deny": ["sh(git push*)", "edit(.git/**)", "sh(rm -rf /*)"] }`, with project and user files merged (deny wins). A built-in **deny floor** that applies in every mode including yolo: destructive filesystem commands outside the workspace, `curl | sh`, force pushes, writes to `.git`. "Always allow" in the approval dialog can persist a rule (opt-in). `/permissions` lists the effective rules.
**Accept.** Tests: deny beats allow; allow skips the prompt; the floor blocks `rm -rf /` in yolo with a message the model can act on; glob matching on paths and command prefixes; invalid rule files give a clear error.

### G4. Background processes
**Why.** `sh` blocks until the command ends, so the agent cannot start a dev server or a test watcher and look at its output later. (Our own judgment; common in agents.)
**Build.** Tools `sh_start` (returns an id), `sh_read` (new output since last read, with a cap), `sh_stop`, and `sh_list`. Output is ring-buffered, processes are killed on exit and on `/clear`, and they run under the same permission rules as `sh`. Show running processes in the sidebar.
**Accept.** Tests: start a process that prints over time, read in increments, stop it; leaked processes are cleaned up on exit; approval is required like `sh`; a process that exits reports its code.

### G5. Better edit formats
**Why.** The harness study treats editing strategy as a major accuracy factor; Aider makes the format pluggable and Codex uses `apply_patch`. We have exact-match `edit_file` and whole-file `write_file` only.
**Build.** (a) `apply_patch` accepting a unified diff or the Codex-style patch envelope across several files, applied atomically with a clear error per hunk. (b) `edit_file` accepts a list of edits applied in order, all-or-nothing. (c) A whitespace-tolerant fallback for `old` (trim trailing spaces, normalise indentation) that only applies when exactly one candidate matches, and says so. Keep read-before-edit.
**Accept.** Tests: multi-file patch success and rollback on a bad hunk; multi-edit atomicity; fuzzy match accepted when unique and refused when ambiguous; diffs still reach the UI as `edit` events. Add 2 eval tasks that need multi-file edits.

### G6. OS-level sandbox for shell commands
**Why.** Codex uses Seatbelt (macOS) and Bubblewrap/Landlock (Linux) and keeps `.git` read-only; Gemini CLI offers Docker/Bubblewrap/gVisor; Claude Code has an opt-in sandbox with network limits. Our shell can do anything the user can.
**Build.** Opt-in `sandbox: "off" | "workspace" | "strict"` (CLI `--sandbox`, `/sandbox`). macOS: `sandbox-exec` profile (write only inside the workspace and temp, `.git` read-only, network off in strict). Linux: `bwrap` when present. Otherwise report clearly that no sandbox is available and fall back to the permission prompts. Scrub environment variables (keys) from sandboxed commands.
**Accept.** Tests on macOS and Linux CI: a command cannot write outside the workspace or into `.git`; network is blocked in strict; allowed builds and tests still run; missing sandbox tool gives a clear message, not a silent downgrade.

## P2

### G7. Skills (`SKILL.md`)
**Why.** Skills appear in nine of eleven systems; Codex and Gemini read `.agents/skills`, Claude Code reads `.claude/skills`, OpenCode reads both.
**Build.** Discover `.agents/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, `.amness/skills/*/SKILL.md` and the user-level equivalents. Put only each skill's name and one-line description in the prompt; a `skill` tool loads the full body (and lets it reference files in its folder) on demand. `/skills` lists them.
**Accept.** Tests: discovery across the three folders with precedence; progressive disclosure (body not in the prompt until loaded); a skill-relative file can be read; malformed front matter is skipped with a warning.

### G8. Custom subagents
**Why.** Claude Code, Codex, Gemini CLI and Copilot CLI define agents in files (`.claude/agents/`, `.codex/agents/`) with their own tools, model and permissions. Ours is one read-only explorer.
**Build.** `.amness/agents/<name>.md` with front matter (`description`, `tools`, `model`, `mode`) and a prompt body. `task` takes an `agent` name. Child permissions are derived from (never wider than) the parent. Optional `isolation: worktree` runs a writing subagent in its own git worktree and returns a diff for review.
**Accept.** Tests: a custom agent sees only its tools; its model override is used; permission narrowing; a worktree subagent leaves the main tree untouched until merged.

### G9. Model routing
**Why.** One model does everything, including exploring and writing handoff notes. Using a cheaper model for those saves cost.
**Build.** Config `models: { explore, compact, edit, review }` with sensible defaults (same as the main model). Subagent explore calls, `makeHandoff`/`/compact`, memory consolidation and the eval judge pick from it. Add provider fallback when a model errors or is overloaded.
**Accept.** Tests: each role calls the configured model; unset roles use the main model; fallback is used after a retryable failure; `/status` shows the routing.

### G10. Code index / repo map
**Why.** Aider's ranked repo map is the only code index in the studied corpus; most agents rely on grep. For large repos a compact symbol map saves many exploration turns.
**Build.** A zero-dependency symbol index (regex-based extractors for TS/JS, Python, Go, Rust, Java, C-like; cached by file mtime) with a `repo_map` tool that returns the most relevant files and their top-level symbols for a query, ranked by identifier overlap and reference counts. Optional: tree-sitter if installed.
**Accept.** Tests: symbols extracted for each language fixture; ranking puts the defining file first; cache invalidates on change; output stays under a token cap. Add an eval task on a medium synthetic repo.

### G11. Language-server diagnostics after edits
**Why.** OpenCode appends LSP diagnostics to edit results. We only support a user-supplied check command.
**Build.** If a known server is on PATH (`typescript-language-server`, `pyright`, `gopls`, `rust-analyzer`), start it lazily over stdio, send the edited file, and append new errors for that file to the edit result (errors only, capped). Falls back to `/check`.
**Accept.** Test with a fake LSP server speaking the protocol: an edit that introduces an error returns it; a clean edit adds nothing; a missing server is silent.

### G12. Tracing
**Why.** Gemini CLI and Mistral Vibe export OpenTelemetry traces; Pi audits the dollar cost of cache invalidations.
**Build.** Always-on, local JSONL trace per session in `.amness/traces/` (turn, tool, hook, cache-break, trim, approval events with timings). Optional OTLP/HTTP export (`--otlp <url>`) using plain `fetch`, GenAI semantic-convention attributes. `/loop` and `amness eval` show "tokens wasted by cache breaks" using the pricing table.
**Accept.** Tests: trace file contents for a scripted run; OTLP payload shape against a mock collector; the waste figure matches a hand-computed example.

### G13. Git worktrees, review and PRs
**Build.** `--worktree <name>` starts the session in a fresh worktree; `/review` runs a read-only review subagent over the current diff; `/pr` drafts a title and body and runs `gh pr create` only after confirmation.
**Accept.** Tests with a temp repo: worktree creation and cleanup; `/review` makes no writes; `/pr` shows its command and does nothing without approval.

### G14. Better loop detection
**Why.** Gemini CLI uses hybrid loop detection; ours catches exact repeats only, so an A-B-A-B cycle passes.
**Build.** Detect cycles of length 2 to 4 in the recent call signatures, and near-duplicates (same tool, same path, tiny argument differences). On detection, inject a reflection message first and refuse on the second hit.
**Accept.** Unit tests for A-B-A-B and A-B-C-A-B-C; no false positive on legitimate repeated reads of different ranges.

### G15. Prompt-injection and secrets hardening
**Build.** Tag tool output from the web, MCP servers and files outside the workspace as untrusted in the transcript; parse shell commands (quotes, subshells, pipes, redirections) instead of regex matching before risk checks; redact known secret patterns (API keys, tokens, private keys) from tool output and from the trace; scrub the environment passed to child processes.
**Accept.** Tests: injection-style web text cannot change permissions; quoted/obfuscated destructive commands are still flagged; secrets in output are masked in transcript and trace.

## P3

### G16. Editor integration
An Agent Client Protocol server mode (`amness acp`) so JetBrains and Zed can host Amness, then a thin VS Code extension.

### G17. Image input
Accept image paths and pasted screenshots; send them to models that support vision (OpenAI and Claude adapters); size limits and a clear message for text-only models.

### G18. Session branching
Fork a conversation from any earlier turn (Pi's session tree); `/branches` to switch. Filesystem state is restored from the checkpoints that already exist for rewind.

### G19. Scheduled and background agents; GitHub Action
`amness schedule` for recurring headless runs, plus a published GitHub Action wrapping `amness run --json` with a PR-comment summary.

### G20. LLM approval reviewer
An optional cheaper-model reviewer that approves or escalates risky calls with a stated reason, logged in the trace (Codex has this layer).

### G21. Windows and Docker
Test on Windows (paths, shell, sandbox); build and run the Docker image in CI.

### G22. Publish to npm
Needs a build step (or a bundled runtime) because the CLI currently relies on Node's TypeScript type stripping.

---

## Sources

- [Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents: A Source-Code Study of Eleven Systems](https://arxiv.org/html/2609.00006v1): hooks, sandboxes, skills, subagents, tracing and indexing across Claude Code, Codex, Gemini CLI, OpenCode, Aider and others.
- [CLI Coding Agents Comparison](https://hidekazu-konishi.com/entry/cli_coding_agents_comparison.html): hooks, skills, subagents, IDE integration and instruction-file conventions per tool (a blog; "not documented" there does not mean absent).
- [A Comparison of AI Agent Harnesses in 2026](https://winder.ai/ai-agent-harness-comparison/) and [Code as Agent Harness](https://arxiv.org/html/2605.18747v1): surveys of the landscape.
- [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804): editing strategy and action space matter; keep stuck detection and post-edit checks.

Several of these sources are blogs and disagree on details; verify against each tool's official docs before copying a behaviour.

## Done log

Newest first. When an item is finished, tick it above and add one line here with the commit.

- (nothing closed yet)
