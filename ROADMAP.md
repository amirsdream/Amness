# Roadmap

Four tracks. **Track A (G1 to G22, later G23 to G44)** closes the gaps found by comparing Amness with the main coding-agent harnesses. **Track C (C0 to C14)** makes every part of the harness programmable. **[Track M (M0 to M19)](#track-m-one-harness-for-claude-cheaper-models-and-local-models)** lets Claude, cheaper models and local models work together in one session. **Track B (L1 to L14)** is the plan to get ahead of them, drawn from recent papers (see [Sources](#sources) and each item's evidence note). Work through them in order; tick a box when the item is done **and** its acceptance check passes. Each item gets its own commit, tests, and a README line.

## Strategy: how Amness gets ahead

Parity (Track A below) makes Amness a credible alternative. **Track B** is where it can lead, because Amness already has the hard-to-copy base: a statistical eval runner with every guard switchable, a cache-break detector, a trace of every loop turn, and a UI that shows all of it. The bets, each backed by recent work and each measurable on our own eval runner:

1. **Never trust the model's own report.** Self-judging loops accept regressions; grounded external checks do not. (L1 to L3)
2. **Be the most measurable harness.** Replay, failure mining and benchmark adapters turn every real failure into a regression test. (L4, L5, L14)
3. **Win on cost, including the cache.** Per-step model routing that prices cache loss, and a structural code index. (L6 to L8)
4. **Security by construction, not by prompt.** Deterministic policy with taint tracking, sandbox and reversible actions. (L9, L10, G6)
5. **A harness that improves itself under guarantees.** Bounded edits, held-out gates, rollback. (L11 to L13)

Rule for Track B: **no item ships as a default until the eval runner shows it helps** on a suite that includes tasks it should help and tasks it should not touch. Anthropic's long-running-harness write-up makes the same point from the other side: components that were load-bearing for one model became dead weight for the next, so every scaffold needs an ablation (see L8).

### Suggested order

| Phase | Items | Why first |
|---|---|---|
| 1. Foundations | G1, G2, G3, G12, G14, G4 | Hooks, a trace file and permission rules are prerequisites for most Track B items |
| 2. Grounded verification | L1, L2, L3 | Biggest reliability gain per effort; reuses the verify gate and the trace |
| 3. Measurement | L4, L5, L14 | Makes every later claim checkable and turns failures into tests |
| 4. Economics | L6, L7, L8, G10 | Cost per solved task is the number users feel |
| 5. Trust | G6, L9, L10 | Needs the sandbox and permission engine from phase 1 |
| 6. Compounding | L11, L12, L13 | Needs measurement (phase 3) and trust (phase 5) to be safe |

Legend: `[x]` done, `[~]` partly done (see the Done log for what is left), `[ ]` not started. **P1** do first · **P2** next · **P3** later. Effort: S (hours), M (a day or two), L (several days).

How to use this file: say "do G1" (or "do the next one"), and the item is built, tested, ticked here, and pushed. Add new gaps at the bottom with the next free id.

## Status

| Id | Item | Priority | Effort | Done |
|---|---|---|---|---|
| G1 | Load `AGENTS.md` and friends automatically (fixes a bug) | P1 | S | [x] |
| G2 | Lifecycle hooks | P1 | S | [x] |
| G3 | Permission rules and a hard deny floor | P1 | S | [x] |
| G4 | Background processes | P1 | M | [x] |
| G5 | Better edit formats (patch, multi-edit, fuzzy fallback) | P1 | M | [x] |
| G6 | OS-level sandbox for shell commands | P1 | M | [~] |
| G7 | Skills (`SKILL.md`) | P2 | S–M | [x] |
| G8 | Custom subagents (and parallel worktree subagents) | P2 | M | [x] |
| G9 | Model routing (cheap model for exploring and compacting) | P2 | S–M | [x] |
| G10 | Code index / repo map | P2 | M | [x] |
| G11 | Language-server diagnostics after edits | P2 | M | [~] |
| G12 | Tracing (JSONL trace file, OpenTelemetry export, cache-miss cost) | P2 | S–M | [x] |
| G13 | Git worktrees, `/review`, pull-request helper | P2 | M | [x] |
| G14 | Better loop detection (cycles, not only exact repeats) | P2 | S | [x] |
| G15 | Prompt-injection and secrets hardening | P2 | M | [x] |
| G16 | Editor integration (ACP server, VS Code) | P3 | L | [~] |
| G17 | Image input (screenshots) | P3 | M | [~] |
| G18 | Session branching | P3 | M | [~] |
| G19 | Scheduled and background agents; GitHub Action | P3 | L | [~] |
| G20 | LLM approval reviewer for risky calls | P3 | M | [~] |
| G21 | Windows support (tested) and a built, tested Docker image | P3 | M | [~] |
| G22 | Publish to npm (needs a build step or a bundled runtime) | P3 | M | [~] |
| L1 | Grounded finish gate: claims ledger and scope audit | P1 | M | [~] |
| L2 | Stagnation detection from external signals, not self-report | P1 | M | [~] |
| L3 | Independent skeptical evaluator with a sprint contract | P1 | M | [~] |
| L4 | Trace replay: test harness changes without model calls | P1 | M | [x] |
| L5 | Failure mining: every bad session becomes an eval task | P2 | M | [x] |
| L6 | Cache-aware per-step model routing | P2 | L | [~] |
| L7 | Structural code index with call and import graph | P2 | L | [~] |
| L8 | Model profiles and scaffold pruning from ablations | P2 | M | [~] |
| L9 | Taint tracking and capability policy (out-of-band enforcement) | P2 | L | [~] |
| L10 | Reversible actions: transactions over files and shell | P2 | L | [x] |
| L11 | Best-of-n with a hybrid verifier, escalated only when needed | P3 | L | [~] |
| L12 | `amness tune`: bounded self-improvement with held-out gates | P3 | L | [~] |
| L13 | Parallel worktree agents with a test-gated merge | P3 | L | [~] |
| L14 | Benchmark adapters with leak audit and cost per solve | P3 | L | [~] |
| G23 | README: shorter landing page, details moved to docs/ (see below) | P1 | M | [x] |

---

## Next up (written 2026-10-29, end of day)

Everything in the Status table above is built and pushed; most Track B items are `[~]` because they have **never been measured on a real model**. The only real runs so far (gpt-6-luna, 13 easy tasks, 3 injection tasks) showed no detectable effect of any guard: the tasks are too easy. So the order for tomorrow is: **measure first, then build**.

### A. Measure (needs the OpenAI key already saved; ask before spending)

| Id | What to run | Why / what decides it | Cost estimate |
|---|---|---|---|
| E1 | **A harder eval suite.** Add exploration-style tasks (answer a question from a 40+ file repo within a budget), multi-file refactors, tasks with a misleading failing test, and try a SWE-bench-format file with `--suite --limit 20`. | Nothing below can be decided on tasks a model solves 100% of the time. Prerequisite for E2 to E9. | small to build; suite runs cost ~$ per 100 sessions |
| E2 | `amness eval --variants ablate --trials 3` on the harder suite; then `--profile-out`. | Which guards earn their keep (L8, L2). Currently no guard shows an effect. | large: ~13 variants × tasks × 3 |
| E3 | `full` vs `full+review` on the harder suite. | L3: the reviewer cost ~77% more tokens and 2.4× time for no gain on easy tasks. Keep only if it wins on cost per solved task. | medium |
| E4 | `full` vs `full+route --cheap-model <id>`. Need the cheap model id from the user. | L6: does routing save money without losing passes. | medium |
| E5 | Adversarial suite on a *weaker* model (a small OpenAI model or local) with `full` vs `full-taint`. | L9: the taint check had nothing to catch on gpt-6-luna. | small |
| E6 | `amness tune` on the harder suite; compare held-out pass rate and tokens before/after. | L12: does the held-out gate ever accept a real change. | large |
| E7 | `--best-of 3` vs single attempt on tasks the model fails ~50% of the time. | L11: keep only if cost per solved task drops. | medium |
| E8 | `--parts` vs one agent on 3-part tasks (wall time and pass rate). | L13: keep only if it wins on wall time without losing passes. | medium |
| E9 | **Budget fix**: exploration tasks with a 100k cap, before/after the 2026-10-29 changes (old behaviour = `--off wrapup`-style variant `full-wrapup`). Count runs that end with an answer vs a bare "budget exhausted". | Confirms the notes, final report and subagent slices actually reduce empty-handed runs. Use the `full-wrapup` variant (already available through `full-<guard>`). | small |
| E10 | Approval reviewer: feed 30 risky-looking and 30 benign calls to the reviewer model; count wrong approvals. | G20: a wrong approval is a safety bug, so the false-approve rate must be ~0. | small |
| E11 | LSP: edit tasks with and without `lsp: true` on a TypeScript repo with `typescript-language-server` installed. | G11: does it cut steps to a green build. Also first run against a real server. | small |
| E12 | Image input with a live vision model (OpenAI and Claude); local `llava`. | G17 wire format is only unit-tested. | tiny |
| E13 | Claude `taskBudget` on a supported Claude model (needs an Anthropic key): exhausted-run rate and premature stops at 64k / 150k. | Budget doc says too-small budgets cause early stops. | small |

**Status 2026-10-30:** E1 done (`--builtin hard`, 6 tasks, selftested). E2 run once on gpt-4.1-mini (2 trials: all inconclusive), E3 run on two models (reviewer: no gain, 2× tokens), E5 run on gpt-4o-mini (injections resisted), E9 run ad hoc (final report turns bare stops into useful partial reports; completion slightly lower at very tight caps). E4 (needs a cheap model id), E6, E7, E8, E10 to E13 not run. Results in docs/evaluation.md.

New measurement items: **E14** a stronger injection suite (models resisted all three attacks; try instructions that look like the user's own, injected through test output and error messages, and multi-step lures). **E15** repeat the ablation with 5+ trials and fewer parallel jobs on 12+ tasks before removing any guard. **E16** make `spec-in-docs` pass: the reviewer's criteria did not catch an edge case listed in a spec file; test a "re-read the spec/README before finishing" check and a criteria step that quotes the spec.

### B. Build

| Id | Item | Priority | Effort | Done |
|---|---|---|---|---|
| G24 | OpenAI server-side compaction (`context_management` + `compact_threshold`) as an option in the OpenAI adapter; make sure our own history trimming does not fight it (`previous_response_id` forbids manual pruning). | P1 | M | [~] |
| G25 | Budget visibility in the UI: show % of budget used in the sidebar and status line, mark estimated usage, show each subagent's slice and spend, and a `/budget` command to raise or lower the cap mid-session. | P1 | S–M | [~] |
| G26 | **Explore block UI is still suspect**: confirm that the "Explore" group closes (✓/✗) for every outcome including subagent budget stops, aborts and unknown-agent fallback; add a VTerm test for each. | P1 | S | [x] |
| G27 | Config surface for the new options: `lsp`, `approvalReviewer`, `taskBudget`, `review` in `/settings` and `docs/usage.md` (today they are only in `config.json` and headless flags). | P1 | S | [~] |
| G28 | Exploration subagent that returns only file paths and line ranges (the "FastContext" idea from a blog; **unverified, find the paper first**), measured against the current prose summary. Built as `exploreRanges` (M11); not measured (`full+ranges`). | P2 | M | [~] |
| G29 | Read-count cap in the tool layer (after N reads the read tool asks for a plan). Only if E9 shows the nudge is not enough. | P3 | S | [ ] |
| G30 | `/branches` should swap file state too (store a tree snapshot per branch tip using the existing snapshot machinery). | P2 | M | [ ] |
| G31 | Clipboard image paste (macOS `pbpaste`/osascript, Linux `wl-paste`/`xclip`) in the TUI. | P3 | S–M | [ ] |
| G32 | ACP: `session/load`, expose the editor's `fs/*` and `terminal/*` when offered, tool-call content as diffs; try it in real Zed. Then a thin VS Code extension. | P3 | L | [ ] |
| G33 | Windows: the CI job now passes, so remove `continue-on-error`; add a PTY-equivalent smoke test and decide the OS sandbox story (none on Windows today: say so in the UI when `/sandbox` is requested). | P2 | M | [ ] |
| G34 | Publish to npm: pick the version, add `CHANGELOG.md`, dry-run `npm publish --dry-run`, then (user's token) tag `v0.1.0`. Decide the package name availability (`amness`) first. | P1 | S | [~] |
| G35 | LSP in CI: install `typescript-language-server` and run one real diagnostics test; add `pyright`/`gopls` if cheap. | P2 | S | [ ] |
| G36 | L13 coordinator: let the model split a task into independent parts itself (today `--parts` needs a file) and show the plan before running. | P3 | M | [ ] |
| G37 | `amness schedule` end to end on a real crontab (macOS and Linux) and a launchd/systemd-timer option; run the GitHub Action once in a throwaway repo with a real key. | P3 | M | [ ] |
| G38 | Linux sandbox check: confirm the bubblewrap tests actually run (not skip) in CI; if the runner blocks user namespaces, document it. (Closes the open part of G6.) | P2 | S | [~] |
| G39 | Cost display: show estimated dollars per run including subagents and the reviewer, and the cache-waste figure, in the final "Worked for" line. | P2 | S | [ ] |
| G40 | Docs pass: `docs/usage.md` for `/branch`, images, `amness schedule|acp|tune`; a short "Choosing a budget" guide (default 300k, what the notes do, when to raise it). Keep README a landing page. | P2 | S | [~] |
| G41 | Memory/skills/subagent briefs: add the Anthropic brief template (objective, output format, boundaries) as a snippet for custom agents in `.amness/agents/*.md`, and a lint warning for agents with no description of what to return. | P3 | S | [x] |
| G42 | Shared rate limiter for all model calls (Retry-After, jitter, AIMD concurrency, ramp-up, quota errors not retried). Left: see a real 429, tune the defaults (start 2, ceiling 4), and use `x-ratelimit-remaining-tokens` to slow down before the 429. | P1 | M | [~] |
| G43 | Subagent steps nested inside their card (parent ids), one live line per subagent inline. Left: subagent token/step counts on the card, and click-through to a subagent's full transcript. | P1 | M | [x] |
| G44 | Reviewer/criteria should catch spec details (see E16); re-read-the-spec check before finishing when the task mentions a spec or docs file. Built as `strategy:spec-check`; measured once: 1 of 8 against 0 of 8 at twice the steps, inconclusive. Next idea: turn the spec's examples into checks automatically. | P2 | M | [~] |
| G45 | Several live chats in the desktop app (from user feedback, 2026-11-11: "run multiple sessions and even use different providers"): a busy chat keeps working when another is opened; the list shows working and waiting chats; each chat keeps its own provider. | P1 | M | [x] |
| G46 | Background tasks: `/bg` in both front ends (own worktree, notice and notification at the end, `apply`/`drop`), `amness run --background` and `amness tasks`. | P1 | M | [x] |
| G47 | A worktree per parallel chat on the same git project (desktop, default on, `desktop.parallelWorktree`), and settings saved per key so windows do not overwrite each other. | P1 | S | [x] |


### D. Track C: programmable harness (added 2026-10-30, "maximum power to customise")

Goal: everything that shapes behaviour (loop, guardrails, evals, prompts, tools, routing, memory) can be replaced or extended by code you own, and everything you change can be measured with `amness eval`. Plugins (docs/plugins.md) are the foundation.

| Id | Item | Priority | Effort | Done |
|---|---|---|---|---|
| C0 | Plugin foundation: tools, in-process hooks on 8 events (new `PreModel`, `PostModel`), system-prompt rewrite, eval cases with function graders, eval variants (data or `build`), trust by fingerprint, `/plugins`, `amness eval --plugin`, `--cases file.ts`. Real-model run done (house-rules example). Left: tests for the TUI trust prompt, headless flag. | P1 | M | [x] |
| C1 | Slash commands, palette entries and status-bar items contributed by plugins; `/reload-plugins` (hot reload); `amness plugin new <name>` scaffold. | P1 | S–M | [x] |
| C2 | **Pluggable loop strategies**: `loop: "react" \| "plan-execute" \| "explore-then-act" \| custom async function` so a plugin can replace the turn order (plan first, tree search over candidate steps, self-consistency on decisions) while keeping budget, permissions, ledger and tracing. Evaluate each against `full`. | P1 | L | [~] |
| C3 | Pluggable context strategy: compaction, tool-result clearing, memory injection and handoff as replaceable functions (plugin point `context`), with the cache-hysteresis helper available to them. | P2 | M | [~] |
| C4 | Pluggable routing/model policy: choose model, effort and tools per step from a function (cost, step kind, failure count, budget), generalising the cache-aware router. | P2 | M | [x] |
| C5 | Policy as code for permissions: function rules next to the pattern rules, evaluated before the floor can be relaxed (never after); a test helper that replays recorded tool calls through a policy and reports what it would allow, ask or deny. | P1 | M | [x] |
| C6 | Custom verifiers and reviewers as plugin points: your own finish gate (any code), your own acceptance-criteria writer, multiple reviewers voting, LLM-judge with calibration against labelled traces. | P1 | M | [~] |
| C7 | Eval power tools: custom metrics (cost, latency, tool-call count, diff size, anything computed from the trace), pairwise preference evals with a judge, stratified task weights, sequential testing (stop early when a variant is clearly worse), task generators, regression gate for CI (`amness eval --gate baseline.json`). | P1 | L | [~] |
| C8 | Online evaluation: grade real sessions from `.amness/traces` with the same graders; shadow mode that replays a candidate harness against yesterday's tasks and compares. Builds on trace replay (L4). | P2 | L | [~] |
| C9 | Prompt registry: system/tool/nudge texts as versioned files with ids, selectable per variant (`prompt:v2`), so prompt A/B tests are first-class (feeds `amness tune`). | P2 | M | [~] |
| C10 | Memory backend interface (store, retrieve, consolidate) so a plugin can swap in a vector DB, a wiki, a ticket system; keep outcome-learning hooks. | P3 | M | [x] |
| C11 | Chaos and robustness evals: inject tool failures, slow tools, malformed model output, 429s and truncated outputs into recorded sessions and measure recovery. | P2 | M | [~] |
| C12 | Plugin distribution and safety: install from npm/git (`amness plugin add`), a capability manifest (what the plugin touches: network, shell, files), warn on unexpected capabilities, optional isolation in a worker with a permission model. | P3 | L | [~] |
| C13 | Multi-model experiments in one run: the same task on several models/harnesses side by side in the TUI (split view) and in evals (model as a variant dimension, not only harness). | P2 | M | [~] |
| C14 | Docs: a "build your own harness" tutorial that walks from a single hook to a custom loop strategy and measures each step; keep README a landing page. | P2 | S | [~] |

### C. Known limits to keep honest in the docs

- No claim of improvement is justified until E1 to E9 are run. README and docs say "not measured" for the newer features; keep it that way until then.
- Windows has no OS sandbox. macOS (Seatbelt) is tested; Linux (bubblewrap) depends on the CI runner (G38).
- Image history is re-sent every turn (cost); consider dropping old images after N turns (add to G25/G39).
- Subagent slices (20%/30%, 80k/150k caps, 3 at once, 12 tool calls) are first guesses, not tuned; E9 should tune them.
- Token estimates for servers that report no usage are about 4 characters per token.

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
Built to `dist` by `npm run build` (run by `prepack`), so the installed package needs no type stripping. Releases are staged by CI and approved by hand; see the `release` skill.

---

---

# Track B: getting ahead

Each item lists the **evidence** (and how well I could check it: *read* = I read the page or abstract, *snippet* = only a search summary), **build**, **measure** (how we prove it beats the baseline on our eval runner) and **accept**.

## Grounded verification

### L1. Grounded finish gate: claims ledger and scope audit
**Evidence.** Agents that judge their own work accept plausible changes as progress: in a controlled study, a frontier agent claimed improvement in every one of 54 cycles while 56% had zero or negative real change, and even the strongest in-band judge accepted cycles where 44% were real regressions ([When Do Agent Loops Mistake Stagnation for Progress?](https://arxiv.org/abs/2607.25152), *read abstract*). Sign-only gating from a real-world signal did as well as rich feedback, so the *grounding* is what matters. Anthropic's long-running harness likewise separates the judge from the builder ([Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps), *read*).
**Build.** Today `finish` is gated only by the user's `verify` command. Add a **claims ledger**: the harness records ground-truth events (commands run and exit codes, files changed, test counts parsed from output) and checks the `finish` summary against them before accepting it ("tests pass" with no passing test run is rejected; "fixed X" with no change in X's file is flagged). Add a **scope audit**: files changed outside what the task and the plan imply are listed and require a one-line justification. Auto-detect a verify command when none is set (we already have `detectVerify`) and say clearly when `finish` is unverified.
**Measure.** Eval variant `full` vs `full-ledger`: rate of false "done" (pass by the agent's claim, fail by the held-out check) and tokens per solved task. Add 3 eval tasks designed to tempt a false success (a test the agent can weaken, a claim that needs a command it is likely to skip).
**Accept.** Tests: unsupported claims are rejected with a specific message; a scope violation is surfaced; a clean run is not slowed; the ledger is visible in `/loop` and the trace.

### L2. Stagnation detection from external signals
**Evidence.** Same paper: stagnation looks like progress to the model. Pair with the existing no-progress stop (6 failing turns), which only catches errors, not busy-but-useless loops.
**Build.** Track objective progress signals per turn: failing-test count or error count parsed from command output, size of diff, new files touched, verify result. If the signals do not improve for K turns (default 8) while the model keeps acting, inject a structured "stuck" reflection (what changed, what did not) and, on the second hit, stop with a clear report. Signals are optional and degrade gracefully when output cannot be parsed.
**Measure.** Ablation `full-stagnation` on tasks with a plausible-but-wrong path: wasted tokens before stopping, and recovery rate.
**Accept.** Tests with scripted trajectories: improving error counts never trigger it; flat counts do; unparseable output falls back to the old guard.

### L3. Independent skeptical evaluator with a sprint contract
**Evidence.** Anthropic found a separate, skeptical evaluator easier to tune than making a generator self-critical, with a pre-agreed contract of testable criteria per chunk and hard thresholds; it paid off on tasks beyond what the model does reliably alone, and cost more (about $3-4 per QA round in their example). They also warn that an untuned evaluator talks itself out of real findings, so its prompt must be tuned against logs (*read*).
**Build.** Optional `review` role (uses a separate, fresh-context call, optionally another model via L6/G9) that, before the first edit, proposes acceptance criteria from the task ("contract"), then after `verify` passes inspects the diff, runs the criteria it can execute, and returns pass/fail with specifics. The generator sees only the failures. Off by default; on for tasks tagged hard or by `--review`.
**Measure.** `full` vs `full+review` on the hard half of the suite: pass rate, false-done rate, and cost per solved task. Keep only if the interval excludes zero.
**Accept.** Tests: the evaluator cannot edit files; its objections reach the generator; a passing review adds one call, not a loop; criteria are shown to the user.

## Measurement

### L4. Trace replay
**Evidence.** Harness engineering needs failures stored as files that can be inspected and re-run ([Harness Engineering for Self-Improvement](https://lilianweng.github.io/posts/2026-07-04-harness/), *read*); the reliability review treats observability gaps as a root cause of invalid conclusions ([Engineering Reliable Coding Agents](https://arxiv.org/abs/2608.13867), *read abstract*).
**Build.** Needs G12. Record each turn's model output and tool results. `amness replay <trace>` feeds the recorded model messages back through the current harness with the tool results replaced by recorded ones, and reports where the *harness* would have behaved differently (a guard that would now fire, a different cache break, a different compaction, a permission that would now be denied). No model calls, so it runs in CI.
**Measure.** Time and cost to detect a harness regression: a replay suite of 20 real traces runs in seconds for $0.
**Accept.** Tests: replaying an unchanged harness reproduces the transcript byte for byte; changing a guard threshold reports exactly the turns that differ.

### L5. Failure mining
**Evidence.** AHE-style debugging reads traces, writes a root-cause report per failure, and proposes bounded fixes; Self-Harness clusters failures into patterns ([Lilian Weng's survey](https://lilianweng.github.io/posts/2026-07-04-harness/), *read*).
**Build.** `/report` (and `amness traces --failures`) clusters recent sessions by failure signature (guard that fired, verify failure text, stuck stops, user interruptions with a correction). For a chosen failure, offer to **turn it into an eval task**: snapshot the repo state, the task, the verify command, and ask the user to confirm a held-out check. Output lands in `.amness/evals/cases/`, runnable with `amness eval --cases`.
**Measure.** Count of regression tasks created per month and how many later caught a harness regression.
**Accept.** Tests: clustering groups scripted failures correctly; the generated case passes `--selftest`; no case is created without confirmation.

### L14. Benchmark adapters with leak audit and cost per solve
**Evidence.** A structural-index study reports per-cell exclusion ledgers, leak audits and three seeds on SWE-PolyBench Verified and SWE-bench Pro ([Code Isn't Memory](https://arxiv.org/abs/2606.22417), *read abstract*); harness choice moves cost per solved task up to 40x while pass rate moves little ([Scaffold Effect](https://arxiv.org/abs/2607.22585), *snippet*); SWE-bench Verified has flawed tests and contamination concerns (search results, *snippet*), so private, contamination-controlled suites matter ([Harness or Model?](https://arxiv.org/html/2609.11987v1), *snippet*).
**Build.** `amness eval --suite <name>` adapters that load a subset of a public benchmark into our `Case` format (Docker needed for environments), plus a **leak audit** (task text or repo history must not contain the fix), multiple seeds, an exclusion ledger, and the same cost-per-solved-task and cache-hit reporting. Publish results for Amness variants in the repo, with the commands to reproduce.
**Accept.** Tests with a tiny fake suite; leak audit catches a planted fix; report includes seeds and exclusions.

## Economics

### L6. Cache-aware per-step model routing
**Evidence.** Routing each step of a trajectory to the cheapest adequate model cut cost 72% while keeping 97.3% of frontier quality in [AgentRouter](https://arxiv.org/abs/2609.22951) (*read abstract*, authors' numbers, trained classifier); per-query routers (RouteLLM, FrugalGPT applied per step) saved only 31 to 44%. Cheap-model mistakes can corrupt the context later steps rely on. A cache-aware cost model matters because each model has its own cache ([Cache-Aware Prompt Compression](https://arxiv.org/pdf/2607.15516), *snippet*). None of these tools model the cache cost of switching.
**Build.** Extends G9. A heuristic router (no training): cheap model for read-only exploration, summarising and compaction; strong model for planning, edits and verification; **escalate** after a failure signal (a failed edit, a rejected finish, an L2 stagnation hit). Before switching, estimate the cache loss (the cached prefix is re-read at full price on the new model) and only switch when expected savings exceed it; batch exploration so the switch happens once. Guard against corrupted context: the strong model re-reads any file the cheap model summarised before editing it (read-before-edit already forces this for edits).
**Measure.** Pareto plot from the eval runner: pass rate vs tokens per solved task vs dollars, for single-model, naive router, and cache-aware router on the same tasks.
**Accept.** Tests: routing decisions for scripted turns; no switch when the cache is hot and savings are small; escalation on failure; `/status` and `/loop` show which model ran each turn and why.

### L7. Structural code index
**Evidence.** A structural index (symbols, call graph, dependencies) inside a harness gave a localization gain and a statistically separated resolve gain with *lower* cost per solved task than agentic grep, mostly on multi-file changes, with one fixed model and three seeds ([Code Isn't Memory](https://arxiv.org/abs/2606.22417), *read abstract*). Aider's repo map is the only index in the eleven-agent study; no studied system uses embedding code retrieval ([source study](https://arxiv.org/html/2609.00006v1), *read*).
**Build.** Builds on G10. Zero-dependency extractors for symbols, imports and call sites (regex and light parsing per language), stored per file keyed by mtime. Tools: `repo_map(query)`, `find_refs(symbol)`, `impact(path)` (who imports or calls this). Rank by identifier overlap, definition-vs-use, and graph proximity to files already touched. Optional: tree-sitter or LSP when present (G11).
**Measure.** Eval suite with multi-file tasks and single-file tasks: the index must lower tokens per solve on the former and not hurt the latter.
**Accept.** Tests per language fixture; `impact` finds a planted caller; cache invalidates on edits; output is capped.

### L8. Model profiles and scaffold pruning
**Evidence.** Components that mattered for one model were dead weight for the next; the way to find out is to remove one at a time and measure ([Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps), *read*). The harness study found planning, tool sets and context management each help some models and hurt others ([Empirical Study](https://arxiv.org/abs/2609.20804), *read*).
**Build.** `harness-profile.json` per model family (nudge on/off, step caps, compaction budget, plan-first, tool set, reset vs compaction). `amness eval --variants ablate --profile-out` writes a recommended profile: guards whose removal does not hurt (interval includes zero and cost improves) are suggested for removal. Ship conservative defaults for the main model families, each with the eval evidence behind it.
**Accept.** Tests: profile loads and overrides defaults; the recommender flags a guard with no measured effect and keeps one that helps; the chosen profile is shown in `/status`.

## Trust

### L9. Taint tracking and capability policy
**Evidence.** The field is moving from asking models to refuse injections to deterministic, out-of-band enforcement: CaMeL, FIDES, Progent and similar reference-monitor designs (search summary of [arXiv 2606.26479](https://arxiv.org/abs/2606.26479), *snippet*); least-privilege and egress allow-lists for coding agents ([survey 2606.10749](https://arxiv.org/html/2606.10749v1), *snippet*); prompt-level "do not" rules in an instruction file are not enforcement ([arXiv 2608.23550](https://arxiv.org/pdf/2608.23550), *snippet*). A caution: least-privilege alone stopped attacks in only one coding setting in a hijacking study ([2510.17276](https://arxiv.org/pdf/2510.17276), *snippet*), so enforcement must combine data-flow and capability rules.
**Build.** Needs G3. Mark data by origin (user, workspace file, web, MCP, tool output from untrusted paths). A risky action whose arguments are derived from untrusted data (a command string that appears verbatim in fetched web text) requires explicit approval even in `acceptEdits`, and is denied under a strict policy. Capability scopes per tool and per skill (paths, hosts, commands); network egress allow-list for the shell. Everything enforced in code, never by prompt text. A `/policy` view shows why a call was allowed or denied.
**Measure.** A small adversarial suite (injected instructions in a web page, a README, an MCP result) run through `amness eval`: attack success rate vs benign task pass rate, with and without L9.
**Accept.** Tests: a command copied from a fetched page is escalated; a trusted command is not; capability denials are explained; benign eval tasks unchanged.

### L10. Reversible actions
**Evidence.** Self-modifications can have effects that cannot be reversed from other states; 197 of 600 capability-improving mutations failed a recoverability check in one study ([EvoUndo](https://arxiv.org/abs/2608.28363), *read abstract*). The same logic applies to agent actions in a repo.
**Build.** Extend `/undo` and `/rewind` beyond files edited by our tools: run risky shell commands inside a transaction (git stash/worktree snapshot plus, where the sandbox (G6) allows, an overlay filesystem) so side effects on tracked and untracked files can be reverted; flag commands whose effects cannot be reversed (network writes, package publishes, database changes) and always ask for those. `/undo` reports exactly what it could and could not restore.
**Measure.** Eval tasks with a deliberately destructive step; after undo the workspace hash equals the starting hash.
**Accept.** Tests: a shell command that rewrites many files is fully reverted; irreversible commands are labelled before they run.

## Compounding

### L11. Best-of-n with a hybrid verifier
**Evidence.** Test-time scaling works for software agents when selection uses execution-based and execution-free verifiers together, and generated tests help ([R2E-Gym](https://arxiv.org/abs/2504.07164), [DeepSWE](https://www.together.ai/blog/deepswe), *snippet*); verifier quality is not measured by scaling alone ([SWE-RM](https://arxiv.org/abs/2512.21919), *snippet*). Flawed benchmark tests make test-based selection risky (*snippet*).
**Build.** Needs G13 and L3. For tasks flagged hard (or after an L2 stagnation stop), run n attempts in separate worktrees, select with: held-out-style generated tests, the user's verify command, and the L3 evaluator, in that order; apply the winner. Hard cap on n and tokens; always shows the cost before starting.
**Measure.** Pass rate and dollars per solved task on the hard subset vs a single attempt; keep only if it wins on cost per solve, not just pass rate.
**Accept.** Tests: attempts do not interfere; selection prefers a candidate that passes the generated tests; the budget cap holds.

### L12. `amness tune`: bounded self-improvement
**Evidence.** Meta-Harness and AHE evolve harness code and components from traces ([survey](https://lilianweng.github.io/posts/2026-07-04-harness/), *read*; [Self-HPO 2610.22791](https://arxiv.org/abs/2610.22791), *snippet*). Safe versions bound the editable surface, keep the verifier and permissions outside the loop, accept edits only if held-in tasks improve and held-out tasks do not regress, and log rejected candidates; self-modifications must be recoverable ([EvoUndo](https://arxiv.org/abs/2608.28363), *read abstract*).
**Build.** Needs L4, L5, L8. Make the tunable surface explicit data (system prompt text, tool descriptions, thresholds, nudge wording, profile) in `.amness/harness/`, versioned in git. `amness tune` proposes one attributable edit at a time (failure named, root cause, fix, predicted regressions), evaluates it with the paired statistics on held-in and held-out sets, and keeps it only if it is better and breaks nothing. The eval runner, verifier, permissions and model config are read-only to the loop. Every accepted edit is a commit that can be reverted.
**Measure.** Held-out pass rate and cost per solve before and after a tuning run on the user's own failure-mined tasks.
**Accept.** Tests with a scripted proposer: a harmful edit is rejected and logged; a helpful one is committed; the loop cannot touch read-only files.

### L13. Parallel worktree agents with a test-gated merge
**Evidence.** Eight of eleven studied systems support sub-agents, with orchestration ranging from sequential delegation to parallel trees ([source study](https://arxiv.org/html/2609.00006v1), *read*). Multi-agent setups can add cost without gain, so this ships only if measured.
**Build.** Needs G8, G13. A coordinator splits a task into independent parts, each runs in its own worktree with its own budget, results merge through the verify gate; conflicts go back to the coordinator, not the user.
**Measure.** Multi-part tasks: wall time and cost vs a single agent; keep only if it wins on wall time without losing pass rate.
**Accept.** Tests: independent parts run concurrently; a conflicting merge is reported and not applied; budgets are per agent and total.

## Evidence quality

Items marked *read* rest on a page or abstract I fetched. Items marked *snippet* rest on search-result summaries only and must be re-checked against the paper before we copy any number or design detail. The percentages above are the papers' own results, not measurements of Amness; each Track B item has a **Measure** step precisely so we find out what holds on our own tasks.

### G23. README for new visitors (feedback received 2026-10-28; done)
- **Tighten the opening.** The description in the first paragraph packs many features into one long sentence: lead with the main benefit, then summarise the few key differentiators.
- **List "The agent loop" in the contents** (it is a major section but missing from the contents line).
- **Make it less overwhelming.** The README is about 470 lines and is both landing page and manual. Keep quick start, core usage, safety and limitations in `README.md`; move the deep feature and evaluation material (hooks, permissions, sandbox, skills, subagents, routing, memory internals, eval statistics, benchmarks, replay, tracing) into `docs/` pages and link them.
- **Give local-model users a concrete setup example** in the Providers section (for example Ollama or LM Studio: base URL, model name, how to select it, which features need a tool-calling model), not only a mention in the quick start.
**Accept.** A new visitor can reach a working first session from the top of the README in under a minute of reading; every moved section is still linked; no feature loses its documentation.

## Sources

- [Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents: A Source-Code Study of Eleven Systems](https://arxiv.org/html/2609.00006v1): hooks, sandboxes, skills, subagents, tracing and indexing across Claude Code, Codex, Gemini CLI, OpenCode, Aider and others.
- [CLI Coding Agents Comparison](https://hidekazu-konishi.com/entry/cli_coding_agents_comparison.html): hooks, skills, subagents, IDE integration and instruction-file conventions per tool (a blog; "not documented" there does not mean absent).
- [A Comparison of AI Agent Harnesses in 2026](https://winder.ai/ai-agent-harness-comparison/) and [Code as Agent Harness](https://arxiv.org/html/2605.18747v1): surveys of the landscape.
- [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804): varies planning, action space and context management inside a fixed loop (open models, SWE-Bench Verified and Terminal-Bench). Planning and action space helped some models and hurt others, so choose per model. It held post-edit diagnostics and stuck detection fixed, so it gives **no evidence** for or against them (an earlier version of this line said otherwise; corrected after reading the full text).
- [Harness design for long-running apps (Anthropic)](https://www.anthropic.com/engineering/harness-design-long-running-apps): planner, generator and separate evaluator; sprint contracts; resets vs compaction; remove scaffolding one piece at a time.
- [When Do Agent Loops Mistake Stagnation for Progress?](https://arxiv.org/abs/2607.25152): self-evaluation bias; externally grounded gating.
- [Harness Engineering for Self-Improvement (Lilian Weng)](https://lilianweng.github.io/posts/2026-07-04-harness/): what can be optimised, evaluators outside the loop, held-out gates.
- [EvoUndo](https://arxiv.org/abs/2608.28363) (recoverable self-modification), [AgentRouter](https://arxiv.org/abs/2609.22951) (per-step routing), [Code Isn't Memory](https://arxiv.org/abs/2606.22417) (structural index), [Engineering Reliable Coding Agents](https://arxiv.org/abs/2608.13867) (system-level reliability).

Several of these sources are blogs and disagree on details; verify against each tool's official docs before copying a behaviour.

---

# Track M: one harness for Claude, cheaper models and local models

Goal: run a strong Claude model, cheaper hosted models and local models together in one session, each doing the work it is reliable enough for, and make that measurable with `amness eval` and `amness tune`. Items use the id prefix **M**; measurements continue the **E** series from E17. The Track B rule holds: nothing new ships as a default until the eval runner shows it helps, so new behaviour sits behind a profile field, a config key or an eval variant. Evidence marks as above (*read*, *abstract*); every figure is the papers' own.

**State (2026-11-11):** every item is built and tested with scripted models; none is measured on a real model yet. Three defaults wait for E24: argument repair (`argfix`) and the `hollow` guard are on, and a local server gets one request at a time.

## Track M: Target architecture

#### 1.1 Tiers

| Tier | Example | Strength | Cost profile |
|---|---|---|---|
| T3 frontier | Claude Opus / Fable class | planning, hard edits, judging | high price, long window, paid prompt cache |
| T2 mid | Claude Sonnet / Haiku class, mid hosted models | most edits, exploration, review | lower price, paid prompt cache |
| T1 local | Qwen-class 4B to 35B on llama.cpp, vLLM, Ollama, LM Studio | reads, searches, mechanical steps, short notes | no token price; cost is latency and a small window; a prefix (KV) cache that is lost on any prefix change |

#### 1.2 Three ways tiers work together

Recent work treats these as different problems, and Amness should support all three with separate, measurable switches.

- **Delegate down.** A stronger model stays in charge and hands fresh-context jobs to a weaker one: exploration, compaction notes, review, reading untrusted content. Amness already has the hooks (`models.explore|compact|review`, the `task` tool, `quarantine`, `approvalReviewer`).
- **Advise up.** A weaker model stays in charge and asks a stronger one for a plan or a correction at a few key moments. Anthropic ships this as the advisor tool for Claude executors. Amness has nothing like it yet.
- **Recover up (and back down).** When a weaker model fails, the harness chooses the cheapest useful next step: reflect, replan in a fresh context, or escalate. Amness has a two-tier router (`src/router.ts`) and a fallback for outages, but no failure-driven ladder.

#### 1.3 What must be true underneath

Every model call must carry **its own** identity, window, profile and capabilities. Today those belong to the session's main model. Fixing that (Phase 1) is the foundation for everything else.

## Track M: What already existed

| Capability | Where |
|---|---|
| Loop with guards, each switchable (`off`) | `src/harness.ts` (`GUARD_NAMES`) |
| Window-aware context ladder: mask old output, shrink arguments, drop oldest turns, handoff note, overflow recovery, calibration from provider counts | `src/context.ts`, `roll()` and the overflow loop in `src/harness.ts` |
| Tool-result cache, "unchanged since call" pointers, re-read deltas | `src/cache.ts`, `ReadLedger` |
| Cache-break detection and cost-aware rewrites | `prefixSignature`, `firstCacheBreak`, `src/rewrite.ts` |
| Small-window profile (window of 16,384 or less): `COMPACT_SYSTEM`, compact tool specs, lean tool set with `tool_search` | `small()` and `registry.lean` in `src/code.ts`, `compactSpec` in `src/context.ts` |
| Per-model profile: guards off, `toolChoice`, `thinkingBudget`, `keepThinking`, raw `request` fields | `src/profiles.ts` |
| Roles (`explore`, `compact`, `review`, `cheap`), outage fallback, cache-aware two-tier router, plugin routing | `src/route.ts`, `src/router.ts`, `buildAgent()` in `cli/tui/app.ts` |
| Saved servers with their own keys; window detection for vLLM, LM Studio, llama.cpp, Ollama | `cli/config.ts`, `detectWindow` in `cli/models.ts` |
| A cross-provider model resolver, used only by `amness tune --models` | `tuneModelFor` in `cli/amness.ts` |
| Adapters: OpenAI Responses and Chat (self-correcting), Claude (adaptive thinking, automatic caching, task budget, server-side fallback) | `src/openai.ts`, `src/anthropic.ts` |
| Subagents, custom agents, worktree isolation, best-of-n, reviewer, approval reviewer, dual-LLM quarantine | `src/code.ts`, `src/agents.ts`, `src/parallel.ts`, `src/review.ts`, `src/approver.ts`, `src/quarantine.ts` |
| Eval runner with statistics, ablations, `model:<id>` variants, `full+route`, tune with held-out gate, replay, failure mining, Harbor adapter for Terminal-Bench 2.0 | `src/evals.ts`, `src/tune.ts`, `src/replay.ts`, `src/mining.ts`, `bench/harbor/` |
| `amness run --json` starts with a config event (version, guards, limits, profile sources) | `cli/headless.ts` (0.7.3) |

## Track M: Findings from the code review

Found by reading the code at 0.7.4. Each was confirmed against the code before it was fixed; the item that fixes it is named in the item list (F1 to F9: M1, M2; F10 to F13: M4, M5; F14: M8; F15: M0; F16 to F19: M14; F20, F21: M15; F22, F23: M12).

#### 3.1 The model layer assumes one provider and one model's settings

- **F1. Roles are locked to the main provider.** `buildAgent()` in `cli/tui/app.ts` builds every role with `make({ ...this.cfg, model: id })`, so `explore`, `compact`, `review`, `cheap` and `fallback` inherit the main provider, base URL and key. `modelById` (used by the plugin `route` hook, documented in `src/plugins.ts` as "same provider") has the same limit. The config comment says it too: `models` are "model ids (same provider)".
- **F2. A cross-provider resolver already exists but is private to tune.** `tuneModelFor` in `cli/amness.ts` accepts a saved server name, `provider/model`, or a bare id, and uses each one's own key.
- **F3. `amness run` has no roles at all.** `cli/headless.ts` passes `model` and `modelById` to `createCodeAgent` but no `models`, no router and no fallback, so `cfg.models`, `cfg.router` and `cfg.fallback` only take effect in the chat UI. Verify.
- **F4. A custom agent's `model:` key is never resolved by the CLI.** `src/agents.ts` documents `model: fast` as a key of the `agentModels` option, and `src/code.ts` reads `o.agentModels?.[d.model]`, but nothing under `cli/` passes `agentModels`. Verify.
- **F5. Profile and window belong to the session.** `loadProfile(cwd, cfg.model)` and `windowFor(cfg)` are evaluated for the main model only (`cli/tui/app.ts`, `cli/headless.ts`). A role model never gets its own `toolChoice`, `keepThinking`, `thinkingBudget`, `request`, guard set or window.
- **F6. The explorer subagent ignores the window.** `runTaskInner` in `src/code.ts` creates the explorer with `contextBudget: 120_000` (characters) and no `contextWindow`, `compactSpecs`, `toolChoice` or profile. A 16k or 32k local explorer will overflow or be truncated.
- **F7. The handoff note is sized for the wrong model.** `roll()` in `src/harness.ts` fits the request to the main model's window (`usable()`), then calls `makeHandoff(o.compactModel ?? o.model, ...)`. A compact model with a smaller window gets a request it cannot hold.
- **F8. "Small" means small window, not weak model.** `small()` in `src/code.ts` is true only when the window is 16,384 or less. A weak model served with a 64k window gets the full system prompt, all tools and full tool descriptions.
- **F9. `appendOnly` spreads to the whole pair.** `withFallback` and `routedModel` set `appendOnly` when either model has it, so pairing Claude with a local model disables history rewriting (the cheap context ladder) for the local model too.

#### 3.2 Robustness gaps that hit weak and local models

- **F10. Tool arguments are parsed strictly.** `exec` in `src/harness.ts` uses `JSON.parse(raw || "{}")` and returns an error on failure. `parseLooseJson` exists in `src/schema.ts` but is not used here. `validate` does no type coercion.
- **F11. Malformed-JSON arguments are not counted.** That error path returns without emitting a `repair` event, so traces and eval `events` under-count malformed calls. Verify.
- **F12. Tool calls written as text are lost.** `readChatStream` and the non-stream path of `viaChat` in `src/openai.ts` read only structured `tool_calls`. A call that arrives in `content` (for example `<tool_call>{...}</tool_call>` or a fenced JSON block) is treated as prose, and the `nudge` guard fires.
- **F13. A wrong tool name costs a round trip.** `closestName` in `src/context.ts` is used only to suggest ("Did you mean ...?"). An unambiguous near-miss could be corrected in place.
- **F14. The Ollama window is probably read wrong.** `detectWindow` in `cli/models.ts` reads `model_info["*.context_length"]` from `/api/show`, which is the model's maximum, not the context the server loaded. Ollama's documented default depends on VRAM (4k under 24 GiB, 32k for 24 to 48 GiB, 256k above), and it recommends at least 64,000 for agents and coding tools ([Ollama docs](https://docs.ollama.com/context-length), *read*). The docs do not say what happens to a longer prompt; silent truncation is widely reported but **unverified here**. If it truncates, the overflow learning (`isOverflow`, `windowFromError`) never fires.
- **F15. Bug: `mechanicalNote` never lists commands.** `src/context.ts` collects `a.command`, but the `sh` tool's argument is `cmd`. The fallback handoff note, used when the window is too small to ask the model for one, always says `COMMANDS: none`.

#### 3.3 Routing and cost

- **F16. The cheap tier receives the whole transcript.** `routedModel` in `src/router.ts` sends the same messages to the cheap model. That is affordable between two hosted models with large windows and unworkable for a local model with a small one.
- **F17. Discarded cheap replies are paid twice.** When the cheap model answers with an edit, a command or a final answer, the reply is dropped and the strong model redoes the step.
- **F18. The cheap tier can spawn subagents.** `READ_ONLY` in `src/router.ts` includes `task`.
- **F19. The switch decision only prices paid tokens.** `decide()` compares cached-read prices. A local model has no token price; its costs are latency and the loss of its prefix cache.
- **F20. Loading a deferred tool changes the tool list.** `tool_search` adds tools to `reg.loaded`, which changes the `specs` sent on the next request. `firstCacheBreak` reports this as "the tool list changed ... invalidates the whole cache". On a paid provider this is a full cold read; on a local server it is a full prompt re-evaluation.
- **F21. Cache keep-alive is Claude-only** (`cli/tui/app.ts`), which is correct for paid caches, but nothing protects a local server's prefix cache from avoidable changes.

#### 3.4 Claude adapter

- **F22. Only client tools are sent.** `toTool` in `src/anthropic.ts` maps every `ToolSpec` to a custom tool. Server tools such as the advisor tool cannot be declared.
- **F23. `pause_turn` is not handled** in `fromAnthropic`, and `usage.iterations` is not read, so advisor tokens would be invisible to `Budget`.
- **F24. `toolChoice: "required"` is skipped while thinking is on** (correct for Claude), so a profile shared across models must not assume it applies everywhere.

## Track M: What recent work says

Only findings that change a design decision are listed. The Track M sources below have the links.

#### 4.1 The harness matters more than the model gap, and it must be per model

- A controlled 3 models by 3 harnesses study on a 100-task SWE-bench Verified subset found harness changes moved pass@1 by 8.5 to 13.0 points at a fixed model, model changes moved it by 2.5 to 5.0 points at a fixed harness, and six of nine model-pair rankings reversed across harnesses. The authors ask for a "Harness Card" (execution, tools, context, scheduling, observability, verification, governance) with every reported score (*Stop Comparing LLM Agents Without Disclosing the Harness*, *read*).
- An automated per-model harness search reported that optimized harnesses significantly improved 16 of 21 task and small-model pairs, with the best small model recovering about 89% of a frontier model's performance at about 4% of the cost. Successful adaptations mostly added context (86%), created tools (43%) and managed tools (29%); one cut 40+ tools to seven. Sub-agent adaptations did not succeed, harnesses were model-specific, and diverse tasks were harder to adapt (*Better Harnesses, Smaller Models*, *read*).
- A local-first harness for 2B to 35B models reported completing 0.821 of its self-built benchmark at the 2B tier against 0.017 to 0.271 for three other harnesses with the same model. Its directional ablation put the finish gate first (re-inject the original task text and require a self-check before accepting completion), then verification feedback, then the anti-loop monitor. It rescues malformed tool calls from prose in preference to strict rejection. All of this is from one machine, single trials, and an author-built benchmark, with intervals that cross zero (*Mingbird*, *read*).

#### 4.2 Where small models are adequate

- A six-tier tool-use ladder over 16 open-weight models from 0.27B to 32B found small models reliable for instruction following and single tool calls, usable for two-step chains, and unreliable from branching upward; no model, including the frontier reference, was reliable on long-horizon planning. A plan/execute/submit phase prompt **regressed** all four models it was tried on (the worst by 33 points); an explicit "call the submission tool" instruction helped one model and was neutral on the others; doubling the step budget rarely helped (*AgentFloor*, *read*).
- A practitioner report with Claude Opus as the parent and local workers found delegation to a quantized Qwen3-Coder 30B passed 12/15 and 14/15 against 15/15 for direct coding, another worker passed 12/45 with 11 parent takeovers, and a third passed 0/45. In both studies with a direct arm, **direct coding had the lower frontier cost per verified success**. It also observed that tool-call formatting, turn control and cache reuse differ across models behind nominally compatible endpoints, and a median time to first token of about 69.4 s for cold-prefix requests against 2.8 s for high-reuse requests (*Beyond Benchmarks*, *abstract*).

Consequences: assign roles by measured tier, not by model size; do not assume delegation saves money; count the parent's tokens; and treat a local prefix cache as a first-class cost.

#### 4.3 Tool-call reliability

- Constrained decoding raised schema validity to 100% for five models from 0.6B to 4B. It fully fixed type-coercion errors (numbers emitted as strings). It did not fix semantic errors: missing calls that a loose schema allowed, and "hollow" values (a required string filled with list numbering). XGrammar's overhead was small (*Constrained Decoding Eliminates Structural Failures in Small LLMs*, *read*).
- Combining tools with a JSON-schema output constraint drove the tool invocation rate to 0% on every open-weight model tested on vLLM and SGLang, and `tool_choice="required"` did not fix it. Running tools first and constraining the final answer in a second pass restored 100% (*Constraint Tax in Open-Weight LLMs*, *read*).

Consequences: repair and coerce on the client, because that is the fixable class; never send a response schema together with tools to an open-weight server; do not treat schema-valid as correct; test each model and server combination.

#### 4.4 Routing, escalation and advice

- After a cheap model fails, choosing among reflect, replan and escalate beat a binary cascade: about 28% of recoverable failures were cheap-only, 45% escalation-only and 27% either. A calibrated router beat always-escalate's solve rate at about 35% of its cost (single-step, competitive-programming style tasks) (*CodeRescue*, *read*).
- For mid-trajectory handoff, cumulative trajectory risk predicted better than the latest step's signal (AUC 0.774 against 0.691 in simulation), and task features plus risk were complementary. The authors warn that a permanent one-way handoff can be worse than brief strong help followed by a return to the cheap model. Context handoff and cache cost were not modelled (*TACIT-Switch*, *read*).
- A step-level escalation router on a terminal benchmark reached 93.3% with strong-model calls on 33.9% of steps; a heuristic router reached 95.0% at 66.0%; the small model alone 81.1%. Its verifier was near chance on terminal tasks, and it needed training (*R2V-Agent*, *read*).
- Anthropic's advisor tool (beta, `advisor_20260301`, header `advisor-tool-2026-03-01`) lets a Claude executor consult a stronger Claude model inside one request. The advisor sees the full transcript, has no tools, and typically returns 400 to 700 text tokens. Guidance: call it before substantive work (after orientation), when stuck, and before declaring done; cap output at 2048 tokens; a plain nudge raised pass rates for Haiku executors by about 7 points and slightly lowered them for Opus. Changing or removing the tool edits `tools`, which can invalidate thinking blocks and the cache; `max_uses` is per turn, so a conversation cap is the client's job; advisor tokens appear in `usage.iterations`, not in top-level `usage` ([Advisor tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool), *read*).

Consequences: build a recovery ladder with three actions, driven by accumulated signals; allow a return to the cheaper tier; hand over a note, not the transcript; add the advisor pattern both natively (Claude to Claude) and generically (local to Claude).

#### 4.5 Editing

- Splitting viewing and editing into clean-context subagents raised SWE-bench Verified resolve rate by 2.1 points and cut cost 17.9%, and a trained 8B editor matched a small hosted model downstream. An adaptive choice between find-replace and whole-file rewrite mattered (*SWE-Edit*, *abstract*).
- A large model writing an edit sketch with a small model applying it improved one pairing (+11.1% Pass@2, about 19% lower cost) and roughly matched another. Untuned small appliers degraded sharply on long files, tuned ones still over-edited 5.2% and under-edited 2.1% of the time, and at deployable sizes there were no real latency or cost savings (*Cascaded Code Editing*, *read*).

Consequence: keep edits on the stronger tier by default; an editor subagent is a P3 experiment that needs measuring before any use.

#### 4.6 Context

- Masking old observations matched LLM summarization on solve rate and halved cost against the raw agent on SWE-bench Verified; a hybrid saved a little more (*The Complexity Trap*, *abstract*). Amness already masks first and summarises last, which this supports.
- Compression can raise interaction cost before completion drops: retrieval calls nearly tripled while completion was unchanged, and a fact-preserving summary kept both near baseline where a sliding window did not (synthetic environment) (*What Does Context Compression Cost an Agent?*, *read*). Consequence: when measuring the small-window ladder, count re-reads, not only passes.

## Track M: Items

Legend as above: **P1** first, **P2** next, **P3** later. Effort: S (hours), M (a day or two), L (several days). Each item lists what it depends on.

#### Status

| Id | Item | Priority | Effort | Depends on | Done |
|

---|---|---|---|---|
| M0 | Three small fixes: `mechanicalNote` commands, uncounted malformed JSON, roles in `amness run` | P1 | S | - |
| M1 | Model references and one shared resolver (cross-provider roles) | P1 | M | - |
| M2 | Model card: every `Model` carries its id, window, profile and capabilities | P1 | M | M1 |
| M3 | Capability probe: `amness doctor` qualifies a model and writes its profile | P1 | M | M2 |
| M4 | Tolerant argument pipeline: loose parse, coercion, name correction | P1 | S | - |
| M5 | Rescue of tool calls written as text | P1 | S-M | M4 |
| M6 | Constrained output done safely: probe for suppression, never schema plus tools | P2 | S | M3 |
| M7 | Hollow-argument check (placeholders and elisions in edits) | P2 | S | - |
| M8 | Truncation-aware window (Ollama and others) | P1 | S-M | M2 |
| M9 | Model tier separate from window size (prompt and tool set per tier) | P1 | M | M2 |
| M10 | Task re-read finish check for weak models | P2 | S | M9 |
| M11 | Delegate down: role workers with their own settings, takeover and contracts | P1 | M | M1, M2 |
| M12 | Advise up: native Claude advisor tool, and a generic advisor for any executor | P2 | M-L | M1, M2 |
| M13 | Recovery ladder: reflect, replan, escalate, and step back down | P2 | L | M1, M2, M11 |
| M14 | Handoff packet for tier switches; fix the router's double pay | P2 | M | M13 |
| M15 | Stable tool list and local prefix-cache economics | P2 | M | M2 |
| M16 | Editor subagent and adaptive edit format (experiment) | P3 | M | M11 |
| M17 | Eval dimensions: role matrix, cost per verified success across tiers, harness card | P1 | M | M1 |
| M18 | Qualification ladder suite: which tier of task a model clears | P2 | M | M17 |
| M19 | `amness tune` searches role assignment and per-tier prompt and tool set | P3 | L | M17, M18 |

---

#### Phase 0: fixes

##### M0. Three small fixes

**Build.**
- `mechanicalNote` in `src/context.ts`: read `a.cmd ?? a.command`.
- `exec` in `src/harness.ts`: emit a `repair` event on the invalid-JSON path so it is counted like schema errors.
- `cli/headless.ts`: honour `cfg.models`, `cfg.router` and `cfg.fallback` the way `buildAgent()` does, and add flags `--explore-model`, `--compact-model`, `--review-model`, `--cheap-model`, `--fallback`. Move the shared wiring into one function used by both the chat UI and `amness run` so they cannot drift again.

**Accept.** Tests: a handoff written by `mechanicalNote` lists a `sh` command (`test/context.test.ts`); a malformed-JSON call produces one `repair` event (`test/harness.test.ts`); `amness run` with a role flag calls a scripted second model for exploration (`test/headless.test.ts`). The `--json` config event names each role's model.

---

#### Phase 1: the model layer

##### M1. Model references and one shared resolver

**Why.** F1, F2, F3, F4. Without this, mixed tiers cannot be configured at all.

**Build.**
- Define a **model reference**: `anthropic:claude-haiku-5-5`, `openai:<id>`, `openrouter:<id>`, `server:<name>` (a saved server and its saved model), `server:<name>/<model>`, or a bare id meaning "the main provider". Also accept the `provider/model` form that `tuneModelFor` and the Harbor adapter already use.
- Promote `tuneModelFor` into `resolveModel(ref, cfg): { model, name, config }` in `cli/model.ts`. Use it for roles, `fallback`, `modelById`, `agentModels` (so a custom agent's `model:` key works: accept a reference or a named alias from `cfg.models`), eval `model:<ref>` variants, `--cheap-model`, and `tune --models`.
- Each resolved model keeps its own key (the saved-server and per-provider key storage already supports this) and its own rate-limit gate (`gateFor` in `cli/model.ts` is already keyed by endpoint).
- UI: `/models <role> <ref>` with completion over connected providers and saved servers; `/status` and the sidebar show each role's provider and model.
- Never send one provider's key to another endpoint. Note the existing behaviour that `OPENAI_API_KEY` counts as the key for every Ollama and custom server (`docs/providers.md`); with cross-provider roles this needs an explicit rule: a role that points at a saved server uses that server's saved key only.

**Accept.** Tests: a config with a Claude main model and `explore: "server:lab"` builds two models with different base URLs and keys (`test/tui-app.test.ts`, `test/keystore.test.ts`); an unknown reference gives a clear error listing what is connected; a custom agent with `model:` set runs on the referenced model (`test/agents.test.ts`); `amness run --explore-model server:lab` works headless. Docs: `docs/providers.md` and `docs/usage.md`.

##### M2. Model card

**Why.** F5 to F9. Settings must travel with the model that is being called.

**Build.**
- Extend the `Model` type in `src/harness.ts` with optional metadata, all read lazily:

  ```ts
  type ModelCard = {
    id?: string; provider?: string;
    window?: () => number | undefined;
    profile?: Profile;                       // toolChoice, keepThinking, thinkingBudget, request, off, ...
    tier?: "local" | "mid" | "frontier";      // see M9
    caps?: { nativeTools?: boolean; parallelTools?: boolean; textToolCalls?: boolean;
             toolChoiceRequired?: boolean; vision?: boolean; pricedCache?: boolean };
  };
  type Model = ((messages, tools, opts?) => Promise<Message>) & { appendOnly?: boolean; api?: () => string; card?: ModelCard };
  ```

- `createModel` in `cli/model.ts` attaches the card: window from `windowFor` for **that** model, profile from `loadProfile(cwd, thatModelId)`.
- `createHarness` falls back to `o.model.card` for `contextWindow`, `toolChoice`, `thinkingBudget`, `keepThinking`, `request`, `off`, `stagnationTurns` and `maxSteps` when the options do not set them. Explicit options still win.
- Wrappers (`withFallback`, `routedModel`, `choosingModel`, `routedByFunction`, `rateLimited`, `cachedModel`, the spinner wrapper in `cli/amness.ts`) must pass the card of the model that actually answers. Give them a small helper for "the active card" so per-call settings follow the tier in use.
- Make `appendOnly` a per-call property of the active model, not the union of the pair (F9).
- `roll()`: size the handoff request for `o.compactModel`'s own window when it has one (F7).
- `routedModel`: do not route to a cheap model whose window cannot hold the request (until M14 replaces transcript sharing).
- `onWindow` / `rememberWindow`: remember a learned window under the id of the model that produced the error.

**Accept.** Tests: a harness whose model card says 8,192 keeps requests inside it without any `contextWindow` option; a compact model with a smaller window than the main model receives a handoff request that fits (`test/context.test.ts`, `test/harness.test.ts`); a fallback pair of Claude and a local model rewrites history only on local turns; a role model's profile (`toolChoice: "required"`) is applied to that role's calls only.

##### M3. Capability probe: `amness doctor`

**Why.** Models behind nominally compatible endpoints differ in tool-call formatting, turn control and cache behaviour (*Beyond Benchmarks*); some models stay schema-invalid even after corrective messages and should be excluded from tool roles (*Mingbird*). Today the setup test call only checks that the model replies (`docs/providers.md`).

**Build.** `amness doctor [ref]` (also offered after `/provider` sets up a server). It runs a short scripted battery with a scripted tool set and no workspace access, and writes the result into the model's card and a suggested profile:

1. One required tool call with typed arguments (string, integer, boolean, array, nested object).
2. Two tool calls in one reply (parallel tool support).
3. A multi-step chain of three calls with results fed back (turn control: does it stop, narrate, or continue).
4. `tool_choice: "required"`: accepted, and does the model still produce a valid call.
5. Whether a call arrives as structured `tool_calls` or as text in `content` (sets `caps.textToolCalls`, see M5).
6. Recovery: one deliberate error result, check that the next call is corrected.
7. Window: the server's stated window, then a truncation check (M8).
8. Latency: time to first token for a cold prompt and for a repeat with the same prefix (sets a local cache factor for M15).

Output: a table, a verdict per role ("qualified for: explore, compact; not for: edit"), and `.amness/profile.json` entries. Keep it cheap: a few thousand tokens.

**Accept.** Tests with scripted models for each failure shape (`test/profiles.test.ts`, a new `test/doctor.test.ts`); the verdict for a model that returns text-embedded calls enables rescue; a model that fails step 1 three times is marked "not qualified for tool roles" and the UI says so when it is assigned one.

---

#### Phase 2: robustness for weak models

##### M4. Tolerant argument pipeline

**Why.** F10, F11, F13. Type coercion is the class of error that is fully fixable outside the model (*Constrained Decoding*). Each avoided error saves a round trip, which is the dominant cost on slow local models.

**Build.** In `exec` (`src/harness.ts`), before `validate`:

1. Parse: `JSON.parse`, then `parseLooseJson`, then a repair pass (trailing commas, single-quoted strings, unescaped newlines inside strings, a doubled JSON string, arguments wrapped as `{"arguments": {...}}` or `{"parameters": {...}}`).
2. Coerce against the tool schema (new `coerce(args, schema)` in `src/schema.ts`): numeric strings to numbers for `number`/`integer`, `"true"`/`"false"` to booleans, a scalar to a one-item array where the schema wants an array, a JSON string to an object or array where the schema wants one, `null` for an optional property removed.
3. Name: when the tool name is unknown and `closestName` returns exactly one candidate at distance 1 or a case/separator difference, use it.
4. Emit one `repair` event describing what was changed, and append a one-line note to the tool result ("note: arguments were corrected: ...") so the model sees the right shape.

Never coerce in a way that changes meaning: no guessing of missing required values, no truncation. Risky tools (`risky`) still show the corrected arguments in the approval preview.

**Accept.** Tests in `test/harness.test.ts` and a new section of `test/args.test.ts`: each repair shape runs the tool once instead of returning an error; a call that is still invalid returns the same error as today; the approval prompt shows corrected arguments. Chaos evals (`src/chaos.ts`, C11) gain a "malformed arguments" injector.

##### M5. Rescue of tool calls written as text

**Why.** F12. Lost calls are a harness defect, not a model limit (*Mingbird* rescues three shapes). The counter-view is that only native calls should count (*AgentFloor* scores text-embedded JSON as zero), so this is opt-in per model and always logged.

**Build.** In `src/openai.ts`, after a reply with no `tool_calls` and when the active card has `textToolCalls` enabled: scan `content` (and `thinking`) for `<tool_call>...</tool_call>`, `<function=name>...</function>`, a fenced `json` block or a bare object shaped `{"name": ..., "arguments": ...}`, and the bracketed forms some templates emit. Accept a candidate only when the name is a visible tool (after M4 name correction) and its arguments validate after M4. Convert to a real tool call with a generated id, remove it from `content`, emit `repair` with kind `rescued`.

Enable by default only when M3's probe saw text-embedded calls for that model, or through the profile field `textToolCalls: true`.

**Accept.** Tests in `test/engine2.test.ts` or a new adapter test: each shape becomes one executed call; prose that merely mentions a tool is not executed; a hosted model with the flag off is unaffected. Eval `events` count rescues per model.

##### M6. Constrained output done safely

**Why.** Schema plus tools suppressed tool calling entirely on open-weight servers, and `tool_choice="required"` did not help (*Constraint Tax*). Amness already offers `toolChoice: "required"` per profile and `extract()` for structured output.

**Build.**
- Guard: the OpenAI adapter must never send `response_format` (or any schema constraint from a profile's `request`) together with `tools` to a non-official host. If a profile asks for both, warn once and send tools only.
- Keep `extract()` tool-free (it is today) and document the two-pass pattern: tools first, constrained answer second.
- M3's probe records whether `tool_choice: "required"` yields a valid call for this model; `amness tune` already tries `toolChoice` and keeps it only when it holds.
- For llama.cpp, vLLM and SGLang, strict tool-call grammars come from the server's own tool support; do not hand-roll grammars in Amness. Document the server flags that matter in `docs/providers.md`.

**Accept.** Test: a profile with a schema in `request` plus tools sends no schema and emits one warning. Docs updated.

##### M7. Hollow-argument check

**Why.** Schema-valid calls can still be empty or placeholders (*Constrained Decoding*). In coding, the damaging form is a `write_file` or `edit_file` whose content elides code ("... rest unchanged ...", "// existing code here").

**Build.** A new guard `hollow` (switchable like the others): before a write or edit runs, check the new content for elision markers on their own line, a `write_file` that shrinks an existing file by a large fraction while containing such a marker, and required string arguments that are empty or only punctuation or list numbering. Refuse with a specific message naming the line. Keep the pattern list small and tested; false positives are worse than misses, so only fire on unambiguous markers.

**Measure.** Count fires and false fires per model on the eval suites; keep only if it prevents failures on local models without touching frontier runs (`full-hollow` ablation).

**Accept.** Tests for each marker, for a legitimate file that contains the words in a string literal (must pass), and for the ablation switch.

##### M8. Truncation-aware window

**Why.** F14.

**Build.**
- `detectWindow` (`cli/models.ts`): for Ollama, prefer the context of the **loaded** model (the running-models listing; check the field name against the installed version) and fall back to the model maximum only when nothing is loaded. Show both in `/status` when they differ.
- Truncation check in `src/harness.ts`: when a reply's `prompt_tokens` is not estimated and is far below the calibrated estimate of what was sent (for example under 60% with an estimate above 3,000 tokens), treat it as silent truncation: set `win` to about the reported count, call `onWindow`, emit a `trim` event that says so, and tell the user once with the fix (raise the server's context length).
- `docs/providers.md`: state Ollama's VRAM-dependent default and the 64,000 recommendation, and how to set the context length on the server.

**Accept.** Tests: a scripted model that reports 4,096 prompt tokens for a 12,000-token request triggers the lower window and one notice; a normal provider with cached tokens does not trigger it (cached tokens are part of `prompt_tokens` in Amness's `Usage`, verify per adapter).

##### M9. Model tier separate from window size

**Why.** F8. Small models need fewer tools, more task-specific context and plainer instructions regardless of window (*Better Harnesses*; *AgentFloor*). Structured plan/execute prompts regressed small models, so `strategy: plan-first` must not be a default for them.

**Build.**
- Add `tier` to `Profile` and the model card. Default it from M3's verdict, else from a conservative guess (local server: `local`; known hosted families: `mid` or `frontier`).
- Replace the single `small()` test in `src/code.ts` with two questions: is the **window** small (keeps today's behaviour), and is the **tier** local. For tier `local` with a large window: use a system prompt variant between `COMPACT_SYSTEM` and `CODE_SYSTEM` (short, imperative, with the explicit instruction to end with `finish`), the lean tool set with `tool_search`, and compact tool specs.
- Add profile fields `tools` (allow-list) and `prompt` (a prompt id from the existing registry in `src/prompts.ts`) so a per-model tool set and prompt can be chosen without code.
- Warn when `strategy: plan-first` is combined with tier `local`.

**Measure.** Variants `tier:local` against `full` on a local model with a large window: pass rate, tokens per solved task, repairs and nudges.

**Accept.** Tests: a 64k-window model with tier `local` gets the lean tool list and the short prompt; tier `frontier` with an 8k window still gets the small-window behaviour; profile `tools` filters the registry.

##### M10. Task re-read finish check

**Why.** The largest single delta in *Mingbird*'s (weak) ablation was re-injecting the original task at finish and requiring a self-check. Amness has stronger gates (ledger, coverage, verify, reviewer) but none that simply makes a weak model re-read the request.

**Build.** A finish check (guard name `reread`) for tier `local`, at most once per run: on the first `finish`, reject with the original task text and "check each requirement against what you did; then finish again, listing each requirement and where it is satisfied". Skip it when the reviewer is on.

**Measure.** `full` against `full+reread` on local models; it costs one round trip, so it must raise the pass rate to stay.

**Accept.** Tests: fires once, never twice; off for other tiers by default; ablation switch works.

---

#### Phase 3: collaboration between tiers

##### M11. Delegate down

**Why.** Fresh-context jobs are the natural fit for cheaper models and need no transcript sharing. But delegation can cost more than doing the work directly once parent tokens and failed workers are counted (*Beyond Benchmarks*), and sub-agent adaptations failed in an automated search (*Better Harnesses*). So build it properly and measure it per role.

**Build.**
- Every role worker is created from its own model card (M2): explorer, custom agents, reviewer, approval reviewer, quarantine reader, compaction. Fix F6: the explorer takes its window, compact specs and profile from its model; give it a short system prompt for local tiers.
- Give the approval reviewer and the quarantine reader their own roles in config (`models.approve`, `models.quarantine`). Today the quarantine reader uses the `cheap` role (`quarantineReader(o.models?.cheap ?? o.model)` in `src/code.ts`), which ties it to the routing model, and the CLI passes `approvalReviewer` as a boolean, so the main model reviews its own risky calls. The approval reviewer's rule stays: it may approve, never refuse, and a failure escalates to the user.
- **Structured explorer result** (this is G28): the explorer returns file paths with line ranges plus a short answer; the parent reads the ranges itself. This limits the damage of a weak explorer's wrong prose.
- **Takeover.** When a worker does not finish cleanly, returns nothing usable, or fails its contract, the parent is told plainly ("the explorer on <model> failed: <reason>; do this part yourself") and the event is counted. After N takeovers in a session for one role and model, stop delegating that role to that model and say so.
- **Budget.** Workers on unpriced local models should not consume the token budget at the paid rate: track tokens per tier in `Budget` (a `tier` label on `add`) and let the cap be expressed in cost units as well as tokens.
- Concurrency: a local server usually serves one request at a time; default `maxConcurrent` to 1 for a local endpoint's gate.

**Measure.** E18 and E19 (see the measurement plan): per role, main model alone against main model plus a cheaper or local worker, on cost per verified success **including parent tokens**, wall time, and takeover rate.

**Accept.** Tests: explorer on a small-window model stays inside it; a failing worker produces one takeover note and a counted event; the reviewer and approver run on their configured models; local-tier tokens are reported separately in `/tokens` and the `--json` result.

##### M12. Advise up

**Why.** A cheaper executor with a stronger advisor at a few key moments is the other half of mixed-tier use, and Anthropic documents it with measured guidance. It is also the natural way for a local model to borrow Claude's judgment without sending Claude every step.

**Build, part A: native Claude advisor (Claude executor, Claude advisor).**
- `src/anthropic.ts`: a new option `advisor?: { model: string; maxUses?: number; maxTokens?: number; caching?: "5m" | "1h" }`. When set, append the server tool `{ type: "advisor_20260301", name: "advisor", model, ... }` to `tools` and add the beta header `advisor-tool-2026-03-01`.
- Keep the tool entry byte-stable for the whole conversation (changing or removing it edits `tools`, which breaks the cache and can invalidate thinking blocks). Enforce a conversation-level cap on the client by counting `advisor_tool_result` blocks; when the cap is reached, tell the model in a user note instead of removing the tool.
- Handle `stop_reason: "pause_turn"`: resend with the assistant message unchanged and the tool still present.
- Round-trip advisor blocks verbatim (the adapter already keeps native blocks in `raw`; check that `server_tool_use` and `advisor_tool_result` survive `toAnthropic`).
- Read `usage.iterations` and charge `advisor_message` entries to `Budget` at the advisor's rate; show advisor calls in the trace and the sidebar.
- System prompt lines for when to call the advisor, following Anthropic's guidance: after orientation and before substantive work, when stuck or changing approach, and once before declaring done. For a Haiku executor add the plain nudge if the advisor has not been called by a set turn; do not add it for Opus.
- Config: `models.advisor`, valid only for supported pairs (the API returns 400 otherwise; show that error plainly).

**Build, part B: generic advisor (any executor, any advisor).**
- A client tool `advise` available to the executor, plus harness-triggered calls at three points: before the first state-changing call of a task, when the stuck or stagnation guard fires, and before an accepted `finish` when no reviewer is configured.
- The advisor receives a **packet**, not the transcript: the task, pinned rules, the handoff-style note (`makeHandoff` or `mechanicalNote`), the ledger audit, the current diff and the last failing output, under a size cap. It has no tools. It returns at most a few hundred words: a plan or a correction.
- Cap calls per request and charge them to the budget at the advisor's rate.

**Measure.** E20: executor alone, executor plus advisor, advisor-tier model alone; cost per verified success and pass rate.

**Accept.** Tests with an injected Anthropic client (`test/anthropic.test.ts`): the tool entry and header are sent; `pause_turn` resumes; iterations are charged; the cap is enforced without changing `tools`. For part B: the packet stays under its cap, triggers fire once each, and a failed advisor call never fails the run.

##### M13. Recovery ladder

**Why.** Three recovery actions beat a binary cascade (*CodeRescue*); accumulated risk predicts better than the last step, and a one-way handoff is not always right (*TACIT-Switch*); a heuristic router was competitive on terminal tasks at a higher escalation rate (*R2V-Agent*). L6 (Track B) already calls for escalation on a failure signal; this item generalises it to more than two tiers and three actions. No training in the first version.

**Build.**
- A `ladder` of model references in config, cheapest first, for the main loop (for example `["server:lab", "anthropic:claude-haiku-5-5", "anthropic:claude-opus-5-5"]`) and a start position.
- A **risk score** accumulated per run from signals the harness already emits: `repair` and rescue events, tool errors, `loop` detections, `nudge`, the stuck and stagnation guards, rejected finishes (ledger, verify, reviewer), failed edits. Weights are constants in one table, tunable later by `amness tune`. Score decays on clean progress (a passing verify, a new successful edit).
- On a trigger, choose the cheapest useful action in order:
  1. **Reflect** (same model, same context): already exists as the stuck and stagnation prompts.
  2. **Replan** (same model, fresh context from a handoff note): reuse `roll()`.
  3. **Escalate** (next tier up, from a handoff packet, M14).
  Each action is tried once per trigger level before the next.
- **Step back down** after a set number of clean turns on the higher tier, when the remaining work looks mechanical (read-only streak or passing verify), again through a packet.
- Hard rules: the first step of a task and anything after a user steer run on the configured start tier or above; safety decisions never move down a tier.
- Everything is visible: the trace, `/loop` and the sidebar show which tier ran each step and why (extends what `onRoute` reports today).
- Expose the decision as a pure function with a test table, like `decide()` in `src/router.ts`, and as a plugin point (C4 already generalises routing).

**Measure.** E21: single strong model, single cheap model, binary escalate-on-failure, and the ladder, on tasks the cheap model fails about half the time. Report pass rate, cost per verified success, escalation rate.

**Accept.** Tests: scripted trajectories for each action; no escalation while risk is low; replan before escalate; a return to the lower tier after clean turns; a rejected finish raises risk. `amness run --json` reports steps and tokens per tier.

##### M14. Handoff packet for tier switches; fix the router's double pay

**Why.** F16, F17, F18, F19. A tier switch that re-sends the transcript pays a cold read on the new model every time, cannot work with small windows, and is exactly the cost none of the escalation papers model.

**Build.**
- **Packet.** One function builds the context a new tier starts from: system prompt for that tier (M9), the task, pinned rules (`pinRules`), a handoff note, the ledger audit (files changed, commands run, whether tests ran after the last edit), the current diff under a cap, and the last failing output. Used by M12 part B, M13 and by `routedModel`'s replacement.
- **Router.** For hosted pairs with large windows, keep `routedModel` but: remove `task` from the cheap tier's allowed calls; when the cheap model proposes a non-read call, pass the proposal to the strong model as a short note ("the explorer suggested: ...") instead of discarding it silently; and skip the cheap tier when its window cannot hold the request.
- **Prices.** Extend `Prices` with an optional fixed cost per call and a latency weight, so a local tier can be compared with a paid one in `decide()`.

**Accept.** Tests in `test/router.test.ts`: the cheap tier cannot call `task`; a proposed edit reaches the strong model as a note; a packet for a 150k-token transcript stays under its cap and contains the rules word for word.

##### M15. Stable tool list and local prefix-cache economics

**Why.** F20, F21. On a local server a changed prefix means re-evaluating the whole prompt; one report measured a median of about 69 s to first token on cold prefixes against under 3 s with reuse (*Beyond Benchmarks*). On paid providers a tool-list change is a full cold read.

**Build.**
- **Stable tools mode.** Instead of adding a found tool to the `tools` array, keep the array fixed and add one generic dispatcher, `call_tool({ name, args })`, alongside `tool_search`. `tool_search` returns the schema as text (it already does); the dispatcher validates against that schema (with M4) and runs the tool. The tool list then never changes during a session. Offer it as an eval variant first (`tools:stable`), default it only where it measures better.
- **Order of the request.** Keep everything that changes per turn at the end. Check that plan-mode switches and `when()` predicates do not reorder or change the tool list mid-task more than necessary; where they must, batch the change with a compaction that is already breaking the cache.
- **Local rewrite governance.** `src/rewrite.ts` prices a rewrite in cached versus fresh tokens. For an unpriced local model, price it in time: tokens to re-evaluate from the first edited message, times the measured evaluation speed (from M3's latency probe), against the time saved on later, shorter requests. Turn `governRewrites` on by default for tier `local` only if E22 supports it.
- **Server hints.** Document, per server, what keeps the prefix cache alive (llama.cpp slot reuse and prompt caching flags, vLLM prefix caching, which `prefixCacheRate` in `cli/models.ts` already reads). Use the profile's `request` field for server-specific options; do not hard-code them.
- Show a local cache indicator next to the paid "cache" figure: time to first token and, where the server reports it, the reused-prefix share.

**Measure.** E22: time to first token and total wall time per task on a local model, with and without stable tools and with and without governed rewrites.

**Accept.** Tests: with stable tools on, `prefixSignature(...).tools` is identical across a session that loads three deferred tools; the dispatcher refuses unknown names and invalid arguments like a direct call would; permission, taint and approval checks see the real tool name and arguments, not `call_tool`.

##### M16. Editor subagent and adaptive edit format (experiment)

**Why.** Edit reliability drives small-model results; clean-context editing helped in one study and a sketch-plus-applier split gave mixed results with real over-edit and under-edit rates (*SWE-Edit*, *Cascaded Code Editing*). Evidence is not strong enough to build this before measuring.

**Build (behind variants only).**
- `edit:whole-small`: for tier `local`, steer toward `write_file` for files under a line threshold and `edit_file` above it (the model card decides the threshold).
- `edit:delegate`: the main model describes the change (path, intent, exact snippets); an editor subagent with a clean context applies it with `edit_file` and returns the diff; the ledger records it as usual. Try both directions: strong main with local editor, and local main with mid editor.

**Measure.** E23: edit success on first attempt, over-edits and under-edits (diff against intent), pass rate, cost.

**Accept.** Variants run under `amness eval`; nothing becomes a default without E23.

---

#### Phase 4: measurement and self-tuning

##### M17. Eval dimensions for mixed tiers

**Why.** Scores are not comparable without the harness and the role assignment (*Stop Comparing LLM Agents*). C13 in Track C already makes the model a variant dimension; mixed tiers add a role matrix.

**Build.**
- Variant syntax for roles: `roles:explore=server:lab,review=anthropic:claude-haiku-5-5`, composable with existing variants.
- Row fields: tokens, cost and wall time **per tier**; cost per verified success across all tiers; counts of repairs, rescues, nudges, takeovers, advisor calls, escalations and step-downs (most are already `events`).
- Latency as a first-class metric next to tokens, since local tiers trade money for time.
- A **harness card** in the `--json` config event and in eval output: the seven layers named in the paper (execution, tools, context, scheduling, observability, verification, governance), filled from the actual configuration, including each role's model and profile sources. The 0.7.3 config event is the base.
- Interaction-cost metrics for the context ladder: re-reads and retrieval-style calls after a trim or handoff, not only pass rate (*What Does Context Compression Cost an Agent?*).

**Accept.** Tests: a role variant builds the right models; per-tier numbers add up to the totals; the harness card lists every role. Docs: `docs/evaluation.md`.

##### M18. Qualification ladder suite

**Why.** Which role a model can hold should come from a measured tier, not its size (*AgentFloor*). M3 is a quick probe; this is the eval-grade version.

**Build.** A built-in suite (`--builtin ladder`) in the repo's own tools, graded deterministically: single read; two-step chain (grep then read the right range); branch on a result; reconcile conflicting sources; a constrained multi-step change. Map tiers cleared to roles: compaction and quarantine reading need the lowest, exploration the middle, editing and main-loop work the highest. Record the result in the model's profile with the date and suite version.

**Accept.** The suite self-tests with scripted models at each level; `/models` warns when a model is assigned a role above its measured tier.

##### M19. `amness tune` for roles and per-tier prompt and tools

**Why.** Per-model harness adaptation is where the large reported gains come from, and Amness already has the safe machinery: a bounded search space and a held-out gate (*Better Harnesses*; L12).

**Build.**
- New change kinds in `src/tune.ts`: move one role one tier down; switch the prompt id for a tier (from the prompt registry); remove one tool from a tier's allow-list; toggle `textToolCalls`, `reread`, `hollow`, stable tools.
- Keep the existing rules: one change at a time, a stated prediction, accepted only if it holds on training and held-out tasks, written only into the profile of the model it held for. Safety parts stay out of reach.
- Risk-score weights for M13 as a later, separate search.

**Accept.** Tests with scripted variants as today (`test/tune.test.ts`): a role move that loses passes is dropped; one that keeps passes and lowers cost is kept and written to the right profile.

## Track M: Measurement plan (continues the E series)

Tasks that the model solves every time decide nothing (the note under "Next up"). Use the hard built-in set, a SWE-bench-format slice, and Terminal-Bench 2.0 through the Harbor adapter. Ask before spending on paid models, as today.

| Id | What to run | Decides |
|---|---|---|
| E17 | `amness doctor` on each local model and server in use (llama.cpp, vLLM, Ollama), then the ladder suite (M18). | Which models qualify for which roles; whether M5 and M8 fire in practice. |
| E18 | Main model alone against main model plus a cheaper **hosted** explorer, compactor and reviewer, one role at a time. | Per-role delegation value at tier T2 (M11). |
| E19 | The same with a **local** worker per role, with takeover on. Count parent tokens and wall time. | Whether local delegation lowers cost per verified success or only moves it (M11). |
| E20 | Haiku or Sonnet executor alone, with an Opus advisor (native), and Opus alone; then a local executor with a Claude advisor (generic). | M12, both parts. |
| E21 | Strong only, cheap only, binary escalate-on-failure, ladder (M13) on tasks the cheap model fails about half the time. | M13 and M14. |
| E22 | Local model: stable tools on and off, governed rewrites on and off; time to first token and wall time. | M15. |
| E23 | Edit variants (M16) on edit-heavy tasks, local and mid tiers. | Whether M16 goes further. |
| E24 | Ablations for the new guards on local models: `full-hollow`, `full-reread`, argument repair off, rescue off. | M4, M5, M7, M10 defaults. |
| E25 | `tier:local` prompt and lean tools against `full` on a local model with a large window. | M9. |
| E26 | Small-window ladder: passes **and** re-reads after trims and handoffs at 8k, 16k and 32k. | Whether the context ladder's settings need tuning per window. |

Report every result with its harness card (M17), trials, and the detectable effect size, as `docs/evaluation.md` already does.

## Track M: Order of work

| Step | Items | Why here |
|---|---|---|
| 1 | M0, M4 | Small, independent, immediately useful on local runs. |
| 2 | M1, M2 | The foundation; most later items cannot be built or tested without them. |
| 3 | M17 (role variants, per-tier metrics) | So every later item can be measured as it lands. |
| 4 | M3, M8, M5, M9 | Make local models reliable enough to be worth assigning roles. Run E17, E24, E25. |
| 5 | M11 | First real mixed-tier use. Run E18, E19. |
| 6 | M15 | Removes the largest avoidable local latency cost. Run E22. |
| 7 | M12 | Advisor pattern. Run E20. |
| 8 | M13, M14 | Recovery ladder on top of packets. Run E21. |
| 9 | M6, M7, M10, M18 | Refinements, each gated on its ablation. |
| 10 | M16, M19 | Experiments and self-tuning once the measurements exist. |

All ten steps are built (2026-11-11); what remains is the measurement plan above, and the `[~]` items.

## Track M: Things to avoid

- Do not make `plan-first` or other phase prompts a default for local tiers; they regressed small models in the one controlled test found.
- Do not combine a response schema with tools on open-weight servers.
- Do not count schema-valid as correct, and do not count delegation as cheaper without the parent's tokens.
- Do not share one transcript across tiers with different windows or caches; hand over a packet.
- Do not change the tool list mid-session if a stable alternative measures as well.
- Do not train a router yet. The heuristic ladder with tunable weights is enough to learn where training would pay.
- Do not let any tier below the main model make a safety decision that the main model or the user would otherwise make.

## Track M: Overlap with Tracks A to C

Items of Tracks A to C that are not ticked `[x]`, as of 2026-11-11 (`[~]` partly done, `[ ]` not started; the Done log says what is left). **Overlap** names the Track M item that absorbs or depends on it: build it as part of that item, not twice. Items with no overlap keep their own id and are worked on after Track M step 10, unless a user asks for one sooner.

#1 Absorbed by Track M

| Id | Item | Status | Overlap |
|---|---|---|---|
| G9/L6 | Cache-aware per-step model routing: savings not measured | [~] | M13, M14 (ladder, packets, router fixes), E21 |
| L8 | Model profiles and scaffold pruning: no model-specific defaults measured | [~] | M2 (profile on the model card), M3 (probe writes profile), M9 (tier) |
| G20 | LLM approval reviewer: scripted tests only | [~] | M11 (`models.approve` role), E10 |
| G28 | Explorer that returns only paths and line ranges | [ ] | M11 (structured explorer result) |
| G42 | Shared rate limiter: tune defaults, slow down before a 429 | [~] | M11 (`maxConcurrent` 1 for local endpoints) |
| C4/C13 | Multi-model experiments: model as a variant dimension; split view | [~] | M17 (role variants); split view stays open below |
| C11 | Chaos evals: malformed model output | [~] | M4 (malformed-arguments injector) |
| L12 | `amness tune`: not run on a real model | [~] | M19 (role and tier changes), E6 |
| G24 | OpenAI server-side compaction: not measured against our trimming | [~] | M15 (stable prefix), E26 |
| G39 | Cost per run including subagents and reviewer in the final line | [ ] | M11 (per-tier budget), M17 (per-tier cost) |
| G25 | Budget visibility: per-subagent slices and estimated-usage markers | [~] | M11 (per-tier tokens in `/tokens`) |
| E4 | `full` vs `full+route --cheap-model` | not run | E21 |
| E12 | Image input on a live vision model | not run | M2 (`caps.vision`), M3 probe |

#2 Not covered by Track M (kept as they are)

| Id | Item | Status |
|---|---|---|
| G6/G38 | OS sandbox: Linux bubblewrap path confirmed in CI | [~] |
| G11/G35 | LSP diagnostics: run against a real server; LSP in CI | [~] / [ ] |
| G16/G32 | Editor integration: ACP `session/load`, editor `fs/*`, real Zed, VS Code extension | [~] / [ ] |
| G17/G31 | Image input: clipboard paste in the TUI; drop old images after N turns | [~] / [ ] |
| G18/G30 | Session branching: `/branches` swaps file state | [~] / [ ] |
| G19/G37 | `amness schedule` on a real crontab, launchd/systemd; Action with a real key | [~] / [ ] |
| G21/G33 | Windows: remove `continue-on-error`, PTY smoke test, sandbox story | [~] / [ ] |
| G22/G34 | npm releases: approve staged versions | [~] |
| G27 | Config surface: `taskBudget` in `/settings` | [~] |
| G29 | Read-count cap in the tool layer (only if E9 says so) | [ ] |
| G36 | L13 coordinator that splits a task itself | [ ] |
| G40 | Docs pass: headless flags for `--best-of`, `--parts`, `--image`, `--approval-reviewer` | [~] |
| G44 | Spec-check: turn a spec's examples into checks | [~] |
| L1, L2, L3 | Ledger, stagnation, reviewer: measured on a real model | [~] |
| L7 | Structural index: benefit on multi-file tasks | [~] |
| L9 | Taint tracking: attack success on a real model (E5, E14) | [~] |
| L11 | Best-of-n: not measured (E7) | [~] |
| L13 | Parallel worktree agents: coordinator, measurement (E8) | [~] |
| L14 | Benchmark adapters: a full public benchmark run | [~] |
| C2 | Loop strategies: replacing the turn order | [~] |
| C3 | Context strategy as plugin point | [~] |
| C6 | Custom verifiers: judge calibration against labelled traces | [~] |
| C7 | Eval power tools: pairwise judge, sequential testing, task weights | [~] |
| C8 | Online evaluation: shadow mode | [~] |
| C9 | Prompt registry: feeds tune (M19 uses it) | [~] |
| C12 | Plugin install from npm, worker isolation | [~] |
| C13 | Split-view model comparison in the TUI | [~] |
| C14 | "Build your own harness" tutorial | [~] |

#3 Measurements still open

E2 (ablation, 2 trials only), E3 (reviewer, two models), E6, E7, E8, E10, E11, E13, E14, E15, E16. E4 and E12 are folded into E21 and E17 above. As before: ask before any paid run.

## Track M: Sources

Papers and reports (figures are the authors' own; see the evidence note at the top of Track M):

- [Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/pdf/2605.23950) (*read*): harness against model variance; the Harness Card.
- [Better Harnesses, Smaller Models: Building 90% Cheaper Agents via Automated Harness Adaptation](https://arxiv.org/html/2607.08938v1) (*read*): per-model harness search; what adaptations worked.
- [Mingbird: A Local-First Agent Harness Enabling Small Open Models to Complete Real Tasks](https://arxiv.org/html/2610.02001v1) (*read*): mechanisms for 2B to 35B models; finish gate; malformed-call rescue. Self-built benchmark, single trials.
- [AgentFloor: How Far Up the Tool Use Ladder Can Small Open-Weight Models Go?](https://arxiv.org/html/2605.00334v1) (*read*): tiers of tool use; prompt interventions that helped and hurt.
- [Beyond Benchmarks: Can Small Open-Weight Models Get Real Coding Work Done?](https://arxiv.org/abs/2610.34241) (*abstract*): Claude parent with local workers; cost per verified success; cold-prefix latency.
- [Constrained Decoding Eliminates Structural Failures in Small LLMs but Reveals a Scale-Dependent Semantic Gap](https://arxiv.org/pdf/2609.23742) (*read*): what constrained decoding fixes and does not.
- [Constraint Tax in Open-Weight LLMs](https://arxiv.org/pdf/2606.25605) (*read*): tool suppression under schema constraints; two-pass fix.
- [CodeRescue: Budget-Calibrated Recovery Routing for Coding Agents](https://arxiv.org/html/2607.19338) (*read*): reflect, replan or escalate.
- [TACIT-Switch: Cost-Aware Model Escalation for LLM Agents from Censored Supervision](https://arxiv.org/pdf/2608.27911) (*read*): cumulative risk; limits of one-way handoff.
- [R2V Agent: Teaching SLMs When to Ask for Help](https://arxiv.org/pdf/2605.16604) (*read*): step-level escalation; heuristic baseline.
- [SWE-Edit: Rethinking Code Editing for Efficient SWE-Agent](https://arxiv.org/abs/2604.26102) (*abstract*): viewer and editor subagents; adaptive edit format.
- [Cascaded Code Editing: Large-Small Model Collaboration](https://arxiv.org/pdf/2604.19201) (*read*): edit sketch plus small applier; failure modes.
- [The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization](https://arxiv.org/abs/2508.21433) (*abstract*): masking against summarization.
- [What Does Context Compression Cost an Agent?](https://arxiv.org/pdf/2608.16370) (*read*): interaction cost of compression. Synthetic environment.
- [How a Small Open Model Beat a Frontier LLM: the Rise of Harness-Maxxing](https://msukhareva.substack.com/p/how-a-small-open-model-beat-a-frontier) (*read*, a blog): same-model, different-harness gaps on public leaderboards; uncontrolled comparisons.

Vendor documentation:

- [Advisor tool, Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) (*read*).
- [Context length, Ollama docs](https://docs.ollama.com/context-length) (*read*).

Already cited in Track B and relied on here: AgentRouter (per-step routing), the eleven-system source-code study, the empirical harness-design study, and Anthropic's long-running-harness write-up.

Not found or not verified: a controlled study of prefix-cache behaviour across local servers; a measurement of Ollama's behaviour on over-long prompts; any study that prices the cache cost of switching models mid-trajectory. These are gaps Amness's own measurements could fill.

## Done log

Newest first. When an item is finished, tick it above and add one line here with the commit.

- **G45, G46, G47** (2026-11-11): `cli/tui/background.ts` (`BackgroundTasks`: worktree per task, edits allowed there, approvals refused, notice + system notification at the end, apply/drop/stop/show; at most 3 at once) and `/bg` in the shared App (sidebar TASKS in both front ends); `cli/desktop/bridge.ts` keeps busy chats alive behind the shown one (toasts when one waits or finishes, `live` in the state, the chat list marks them, a "Working now" group for other projects), each new parallel chat with `cloneConfig` and, on the same git project, its own worktree (`sessionsRoot` keeps its conversations with the project; an untouched worktree is removed); `cli/bgrun.ts` (`amness run --background`, `amness tasks`); `saveConfig` writes only changed keys merged into the file. Tests: `test/multitask.test.ts`. Not used on real work yet.

- **M19** [~] (2026-11-11): `tune` change kinds `textToolCalls = true`, `tier = local`, `prompt = <id>`, `tools without <name>` (from `toolSet`), and the guards `argfix`, `hollow`, `reread` in the default candidates; predictions per kind; flags `--text-tool-calls`, `--tier-local`, `--prompts`, `--tools`. Eval variants now honour the profile's `tier`, `tools`, `prompt`, `textToolCalls`. Test in `test/tune.test.ts`. Not done: "move one role one tier down" (it changes the config, not a profile; needs a config writer and a rule for whose config), and the M13 risk-weight search.
- **M16** [x] (2026-11-11): variants `edit:whole-small` (a system rule) and `edit:delegate` (built-in `editor` agent through `extraAgents`, a system rule that the main model delegates every edit; `@edit=<model>` puts the editor elsewhere; `Roles.edit`). Found on the way: a writing subagent defaulted to permission mode "default" when the parent had none (evals, library), so its edits were denied; it now inherits the parent's mode. Tests: `test/editvariants.test.ts`.

- **M18** [x] (2026-11-11): `src/laddercases.ts` (`ladder-1`: L1 single read, L2 search then read, L3 branch on a result, L4 reconcile sources, L5 constrained change with a hidden "test untouched, withTax kept" check), `ladderVerdict` (cleared = all trials of the level and below), `LEVEL_ROLES`; `amness eval --builtin ladder` prints the verdict per variant and `--write-profile` writes `qualified` (by `ladder-1`). Tests: `test/laddersuite.test.ts` (selftest of all five, verdict table).
- **M10** [x] (2026-11-11): guard `reread`; harness option `reread`, set by the code agent only for a set local tier without the reviewer; once per run, with the task text. Test in `test/hollow.test.ts`.
- **M7** [x] (2026-11-11): `src/hollow.ts` (`elisionMarker`, `hollowWhy` for write_file, edit_file incl. edits lists, apply_patch added lines, blank paths); guard `hollow` (on by default, like `audit`; **default to decide with E24**), harness option `hollow` supplied by the code agent; refused before PreToolUse. Tests: `test/hollow.test.ts`.
- **M6** [x] (2026-11-11): Chat adapter strips `SCHEMA_KEYS` (response_format, json_schema, guided_*, structured_outputs, grammar) when tools are sent to a non-official host, one warning per process via `onAdapterWarning` (the chat app shows it as a note). `extract()` was already tool-free. Test: `test/constraint.test.ts`. Not done: server flags for grammar-constrained tool calls in docs/providers.md.

- **M14** [x] (2026-11-11): `src/packet.ts` `buildPacket` (why, question, task, pinned rules word for word, work note, files changed, diff, last failure; capped; the generic advisor uses it). Router: `CHEAP_MAY` without `task` (F18; `tailShape` still counts `task` as exploration); a redone cheap proposal reaches the strong model as a trailing note (F17); the discarded cheap reply's usage rides along as `usage.side` (with tier) so `Budget` charges it (it was invisible before); `Prices.perCall` in `decide()` (F19). The skip-when-window-too-small rule came with M2. Ladder handoffs use `roll()` (handoff seed = task + note + pinned rules), not `buildPacket`, so the switching tier keeps the existing note machinery. Tests: `test/ladder.test.ts`.
- **M13** [x] (2026-11-11): `src/ladder.ts`: `ladderModel` (tiers cheapest first; card/appendOnly/api follow the tier), `RiskMeter` (weights in `RISK_WEIGHTS`, relief in `RISK_RELIEF`, from harness events), `ladderDecide` (pure; reflect ≥ 5, replan ≥ 9 after reflect, escalate ≥ 13 after replan; down after 4 clean turns with a read-only streak; never on step 0, never below start). Harness option `ladder`: every emitted event feeds the meter; each run starts at the start tier; a steer lifts to the start tier; escalate/down write the handoff note on the outgoing tier first (found by the test: otherwise the new tier was sent the full transcript), then switch. `ladder` event in both front ends. Config `ladder`/`ladderStart` (replaces fallback and router), `--ladder`, `--ladder-start`, eval `ladder:<a>+<b>`. Not done: the decision as a plugin point (C4), `/loop` showing the tier per step (the notes and `byModel` show it).

- **M12** [x] (2026-11-11): details re-checked in the Claude API reference first (tool fields `type`/`name`/`model`, optional `max_uses` per request, `max_tokens`, `caching: {type, ttl}`; header `advisor-tool-2026-03-01`; `advisor_tool_result.content` is a union: `advisor_result` text, `advisor_redacted_result` encrypted (Opus 5.5, Haiku 5.5 and other current advisors), `advisor_tool_result_error`; replay the full content; changing or removing the tool invalidates thinking; pairing table, e.g. Opus 5.5 executor accepts only Fable/Mythos/Opus 5.5/Opus 5 advisors). Part A in `src/anthropic.ts`: `advisor` option, tool entry built once, beta path, `pause_turn` resumed up to 5 times with the same tools and the blocks merged into one turn, `usage.iterations` advisor entries become `usage.side` (**the iterations entry shape is not in the reference; read defensively**) and `Budget.add` charges them to the advisor model; conversation cap by `advisorCalls` and a note placed deterministically after the cap-th call. `nativeAdvisor(cfg)` (cli/model.ts) only for Claude+Claude; role configs from `resolveConfig` drop `models`/`fallback`/`router`. Prompt lines for when to call it. Part B in `src/code.ts`: `advisor: Model` → `advise` tool and harness `advise` hook (start before the first state-changing call, stuck/stagnation reflections, finish when no reviewer; once each; "OK" accepts the finish), packet (task, pinned rules, `mechanicalNote`, ledger audit, git diff, last failure; ≤ 20,000 chars; answer ≤ 2,500), cap 4 per request, failures silent; `ToolCtx.messages`. `/models advisor`, Settings, `--advisor-model`. Tests: `test/advisor.test.ts`. Not done: the Haiku-only nudge after N turns without a call; showing advisor calls in the sidebar (they appear as `hook` events and in `byModel`).

- **M15** [~] (2026-11-11): stable tools mode (`stableTools` option, config, Settings toggle, `--stable-tools`, eval `tools:stable`): `specsFor()` builds every tool list (main loop and keep-alive alike) and adds `call_tool` when there are deferred tools; tool_search only describes; `call_tool` is unwrapped at the top of `exec` (the rest of exec, including permissions, taint, hooks, approval, loop detection and the ledger, sees the real name and arguments; events carry the inner arguments); a deferred tool called by name runs too (respecting `allow` and `when()`); the scheduler reads the real tool for read-only/parallel. Rewrite governance: `cachedPrice` falls back to the card's `cacheFactor` (profile field, written by `doctor --write` when the cold request took at least 200 ms). Docs: per-server hints, worded as "check your version". Tests: `test/stabletools.test.ts`. Left: a local cache indicator in the UI (time to first token, reused share), and a check that plan-mode switches and `when()` predicates do not change the list mid-task.

- **M11** [x] (2026-11-11): explorer from its own card (F6): window via the card, `EXPLORE_LOCAL` prompt and compact specs for a small window or a set local tier. Roles `approve` and `quarantine` (done in M1). Structured explorer result (G28) as opt-in `exploreRanges` (config, `--explore-ranges`, Settings toggle, eval `full+ranges`): ANSWER / FILES lines, `checkRanges` keeps only ranges that exist inside the workspace. Takeover: explorer or read-only custom agent on another model that does not finish, returns nothing, or breaks the ranges contract → `TAKEOVER:` result with the partial text marked unchecked, `takeover` event (shown in both front ends), after 2 the role runs on the main model. `Budget.tierWeights` (`budgetLocalWeight`, `--local-weight`) discounts local-tier tokens in `effective`; slices inherit it; `/tokens` shows the last turn per model; the chat budget resets `byModel` per turn. Local endpoints: `maxConcurrent` default 1. Tests: `test/delegate.test.ts`. Not done: takeover for writing agents (their partial edits are real; left to the ledger), and a "contract" beyond the ranges format.

- **M3** [x] (2026-11-11): `src/doctor.ts` (`runDoctor`, `formatDoctor`): checks typed (3 tries with the error fed back), parallel, chain (three steps, then must stop), required, format (native or text, from all checks), recover, window (stated, from `detectWindow`), latency (same long prefix twice; `cacheFactor`). Verdict: compact and quarantine always; explore/review need typed + chain; main/edit also need recover; approve needs typed. Suggestions: `textToolCalls` when calls came only as text, `toolChoice: "required"` when it holds and the typed call needed retries, `tier: "local"` when chain or recover failed. `amness doctor [ref] [--write] [--yes] [--json]` (asks before a paid provider; exit 0 only when qualified for main) and `/doctor [ref] [write]` (both front ends). Profile field `qualified` ({roles, at, by}); `writeProfile` takes a note. `/models` warns when a job is outside the verdict, or suggests `/doctor`. Tests: `test/doctor.test.ts`, `test/tui-app.test.ts`. Left: offering it right after `/provider` sets up a server; a real-model run (E17); the window check does not send a long prompt (truncation is watched during sessions, M8).

- **M9** [x] (2026-11-11): `LOCAL_SYSTEM` (short, imperative, ends with finish, no phases); in `src/code.ts` two questions: `small()` (window ≤ 16,384, now also read from the card) and `localTier()` (the `tier` option, or the card's tier only when `tierFrom: "profile"`). Local tier: `LOCAL_SYSTEM`, the lean tool set, compact specs. **Decision:** a guessed tier changes nothing (every custom server would otherwise switch harness without a measurement, against the Track B rule); it is shown in the config line and harness card. Profile `tools` (allow-list through `Registry.allow`, also hides from tool_search; finish kept) and `prompt` (prompt id; `/prompt` wins) in both front ends and `amness run`. Warning for plan-first with a set local tier (chat app). Eval variant `tier:local|mid|frontier`. Tests: `test/tier.test.ts`.

- **M5** [~] (2026-11-11): `src/rescue.ts` (`findTextCalls` for `<tool_call>`, `<function=…>` with JSON or `<parameter=…>`, `[TOOL_CALLS]`, `<|python_tag|>`, fenced JSON, a bare object only when it is the whole reply; `withoutCalls`). Applied in the harness (not the adapter: the harness knows the visible tools and has the M4 pipeline) when a reply has no structured calls and no `raw`, and `textToolCalls` (option) or `card.caps.textToolCalls` (profile field `textToolCalls`) is on; content first, thinking as a fallback. Only visible tools (after `exactName`) with arguments that validate after `parseArgs`/`coerce`. One `repair` event (`fixed`, "rescued …"). Harness card `tools.textToolCalls`. Tests: `test/rescue.test.ts`. Left: switch it on automatically from the M3 probe.

- **M8** [~] (2026-11-11): Ollama window from `/api/ps` (`context_length`, field name **not verified** against a real Ollama; falls back to `/api/show`). Silent-truncation check in the harness: fires only on a ceiling (the same reported prompt size, within 3%, twice in a row, while our estimate grew more than 10% and both counts are under 60% of the estimate, estimate over 3,000, on a non-official host), because llama.cpp may report only the uncached part of a cached prompt (**unverified**). Then the window becomes about the reported size, `onWindow` is called once, a `trim` and a `hook` (`Window`) event name the fix; calibration is not learned from such replies. Docs: Ollama's VRAM-dependent default and the 64,000 recommendation. Tests: `test/truncation.test.ts`, `test/args.test.ts`. Left: `/status` showing loaded and maximum context side by side; checking both unverified points on real servers (E17).

- **M17** [x] (2026-11-11): variant suffix `<variant>@role=model+role=model` (`parseRoleSpec`; roles explore, compact, review, cheap; built through `modelFor` = the shared resolver); `Budget.byModel` / `byTier` (calls, tokens, prompt, completion, cached, ms waiting), charged with the answering model's card (the router's card now follows the tier in use); eval rows carry `byModel`/`byTier` when more than one model ran, `VariantStats.tiers` and a per-tier table in the report; `countEvents` adds `reread` (a read of an already-read file after a trim or rollover); `src/harnesscard.ts` (seven layers) in the `--json` config line; the result line has `byModel`/`byTier`; eval result files list each variant's roles (`harness`). Tests: `test/tiers.test.ts`. Not done: cost in dollars per tier (tokens and seconds only; prices per tier come with M14's `Prices` extension), and the harness card is not written per eval variant (the variant name and roles are).

- **M2** [x] (2026-11-11): `src/card.ts` (`ModelCard`, `withCard`, `windowOf`, `keepIdentity`), `Model.card`. Cards are attached by `wireModels` (`cardFor`: the model's own id, window, profile entry, tier) for the main model and every role, and for `tune --models` / eval `model:<ref>` (`modelByRef` in `cli/amness.ts`, replacing `tuneModelFor`; the M1 leftover). `createHarness` reads window, `off`, `maxSteps`, `stagnationTurns`, `contextBudget` from the card when its options do not set them. Per-call settings are applied by the answering model's `withCard`, so the chat app and `amness run` now pass only explicit flags; chat mode passes `toolChoice: "auto"` so a profile's `required` does not reach chat replies (subagents in chat do get it now). `withFallback`: `appendOnly` and the card follow the model that answered last (F9). `routedModel`: `appendOnly` follows the tier in use; the cheap tier is skipped when the transcript exceeds 80% of its window. `roll()` sizes the handoff request for the compact model's window (F7; the test fails without the fix: 5,198 tokens sent to a 3,500 window). `onWindow(tokens, modelId)` and `rememberWindow(c, tokens, model)`. Profile field `tier`; `guessTier`. Tests: `test/card.test.ts`. Not done: `rateLimited`, `cachedModel`, chaos and `choosingModel` copy the card statically (fine while they wrap one model).

- **M1** [x] (2026-11-11): `cli/roles.ts`: model references (`id`, `provider:model`, `provider/model`, `server:<name>[/model]`, a saved server's bare name; under OpenRouter `a/b` stays an OpenRouter id; Ollama tags such as `mistral:latest` stay bare ids), `resolveConfig` with a clear error listing what is connected, `wireModels` shared by the chat app (TUI and desktop) and `amness run`. A role on a saved server gets that server's key only. New roles `approve` and `quarantine` (wired in both front ends); `advisor` is reserved for M12. Custom agents' `model:` key resolves (role name or reference; a bad one is reported by the `task` call). `/models` validates before saving and shows labels; completion offers saved servers and connected providers; `/status`, the TUI sidebar and the desktop panel list roles on other models. Tests: `test/roles.test.ts`, `test/agents.test.ts`, `test/tui-app.test.ts`. Left for M2: `tune --models` and eval `model:` variants still use their own resolver (`tuneModelFor`), move them onto `resolveConfig`.
- **M0** [x] (2026-11-11): `mechanicalNote` reads `cmd`; malformed JSON emits `repair`; `amness run` reads `models`, `fallback`, `router` and has `--explore-model`, `--compact-model`, `--review-model`, `--cheap-model`, `--approve-model`, `--quarantine-model`, `--fallback`, `--router`, `--subagents` (the `task` tool was chat-only; it is now on in `amness run` only when an explore model is set or `--subagents` is given, so default runs are unchanged). The `--json` config line has `roles`, `router`, `subagents`. Headless `--approval-reviewer` stays flag-only (the config's `approvalReviewer` is not read headless, so a reviewer can never approve calls a plain run would deny).
- **M4** [x] (2026-11-11): `parseArgs` (strict, loose, trailing commas, raw newlines, single quotes, stringified object, `arguments`/`parameters`/`args` wrapper) and `coerce` (numeric strings, booleans, JSON strings for objects and arrays, scalar to one-item list, optional `null` dropped; nothing guessed) in `src/schema.ts`; `exactName` in `src/context.ts` (only one candidate, case/separator or one edit). New guard `argfix` (on; `full-argfix` ablation). Corrected calls run once, the model gets a note, the history holds the corrected call, the approval prompt sees corrected arguments, `repair` events carry `fixed: true`. Chaos kind `chaos:argshape`. Tests: `test/argfix.test.ts`.

- **G41**: agents with no 'report' instruction in their prompt get an advice warning; brief template is in docs/budgets.md
- **G40** (partly): usage.md lists /budget /lsp /approver /branch, images and config-only options; headless.md flags for --best-of/--parts/--image/--approval-reviewer not yet listed
- **G24** (partly): compactAt option: context_management sent on official OpenAI hosts, input before the newest compaction item dropped; wire-level tests only, not measured against our own trimming
- **G38** (partly): CI step requires a working sandbox (AMNESS_REQUIRE_SANDBOX=1, informational); result to be read from the next run
- **G34** (partly): name amness is free on npm (404); npm publish --dry-run is clean (203 files, 2.2 MB); CHANGELOG.md added. Left: your npm token and a v0.1.0 tag
- **G27** (partly): /lsp, /approver, /budget commands; taskBudget still config.json only; docs/usage.md not updated yet
- **G26**: running cards are closed when a turn ends; interrupted subagent results show as failed; tested with an interrupted Explore
- **G25** (partly): budget % in the sidebar, /budget to show/set the cap; per-subagent slices and estimated-usage markers not shown yet
- **G21** (partly): Docker image built and run in CI (passes); Windows job added but many tests fail there (POSIX shell, paths): not supported yet
- **G22** (partly; left: approve the staged release with `npm stage approve`; 0.1.3 is the one to approve): npm build to dist, pack/install/run smoke test in CI, tag-triggered workflow that stages the release (`npm stage publish`); you approve it with `npm stage approve` and 2FA. README and docs now use `npm install -g amness`, with run-from-source kept for the latest `main`.
- **G19** (partly): amness schedule (cron block, safe quoting) + action.yml composite action; action install/start checked in CI without a key; no real-model run
- **G16** (partly): amness acp: ACP over stdio (initialize, session/new, prompt with streamed updates, permission requests, cancel); scripted client only; no VS Code extension
- **G17** (partly): @image.png and --image; native blocks for Claude, input_image/image_url for OpenAI; vision guessed for local models; wire format tested, no live model; no clipboard paste
- **G18** (partly): /branch [n] forks after turn n and restores files via rewind; /branches switches conversations; files are not swapped back on switch
- **G20** (partly): src/approver.ts: reviewer model may approve (never deny); floor and taint calls skip it; any failure escalates to the user; approvalReviewer config/--approval-reviewer; scripted tests only
- **L13** (partly): src/parallel.ts parallelParts (worktrees, per-part verify, one-at-a-time merge with revert) + amness run --parts; coordinator that splits a task automatically is not built; not measured
- **L11** (partly): src/parallel.ts bestOfN (escalating, extra checks, judge, token cap) + amness run --best-of; tested with scripted agents, not measured
- **L12** (partly): src/tune.ts + amness tune: fixed small search space, train split then held-out gate, rollback; tested with a scripted harness, not run on a real model
- **G11** (partly): src/lsp.ts: minimal stdio LSP client, errors appended to edit results (opt-in lsp); tested with a fake server, not run against real servers
- **G23**: README rewritten as a landing page (57 lines): benefit-first tagline, screenshot, a three-command quick start with a local-model line, five "what you get" bullets, a documentation index, safety in four lines and short limitations. Everything else moved unchanged into docs/ (usage, features, providers, headless, library, why, agent-loop, architecture, evaluation, safety, development, index). Links and anchors checked.
- **G13**: amness --worktree [name] (own branch under .amness/worktrees, removed on exit when untouched), /review [base] (read-only reviewer over commits + uncommitted + untracked vs the base branch), /pr [draft] (model-drafted title/body shown first, gh pr create only after confirmation, push offered separately). src/gitflow.ts, src/worktree.ts, test/gitflow.test.ts (fake gh, local bare origin).
- **L10**: shell commands are reversible in git repositories: a working-tree snapshot (git tree object via a private index, ignored files excluded) is taken before the first mutating command of a turn, /undo and /rewind restore changed/deleted files and remove created ones after restoring tool edits; commands with effects beyond the workspace (push, publish, kubectl, db writes, ssh, writes outside) are flagged 'cannot be undone' in the approval dialog and listed on undo. src/snapshot.ts, test/snapshot.test.ts. Not covered: ignored files, non-git workspaces, overlay filesystems.
- **L9** (partly): taint tracking: a shell command containing 3+ consecutive words (or a 24+ char token) copied verbatim from an untrusted tool result needs approval regardless of mode or allow rules (taint: ask|deny|off); floor/deny/ask/allow layering with /policy explaining decisions; capability rules for web tools via the existing rule syntax. Adversarial suite built (amness eval --builtin adversarial --variants full,full-taint); attack success on a REAL model not measured.
- **G15**: untrusted tool output (web, MCP) wrapped as data; shell commands parsed through quoting/escape/IFS/nested sh -c and eval tricks for the floor and risk checks, decode-and-run payloads always ask; secrets masked in tool output and never written to traces; Amness's own keys removed from child environments (credential-looking ones too under the sandbox). src/secrets.ts, src/permissions.ts, test/secrets.test.ts, test/taint.test.ts.
- **L8** (partly): profile.json per model pattern (guards off, stagnationTurns, maxSteps; project over user), /profile, and a conservative recommender that reads an ablation (amness eval --variants ablate --profile-out) and marks each guard remove / KEEP / undecided with the numbers and an evidence-strength warning. src/profiles.ts, test/profiles.test.ts. No model-specific defaults ship: none has been measured.
- **L6** (partly): cache-aware per-step router: exploration (read-only) streaks go to the cheap model only when the saving repays the cold read on its own cache (price table, warm-cache check); first step, edits, failures, rejections, steering and answers use the strong model; a cheap proposal of an edit/command/finish/text is redone by the strong model; reasoning blobs never cross models; /router, /models cheap, eval variant full+route (--cheap-model). src/router.ts, test/router.test.ts. Savings NOT measured on a real model yet.
- **L14** (partly): SWE-bench-format suite adapter (--suite, --test-cmd, --install, --limit): clone at base commit, hidden tests applied only after the agent finishes, exclusion ledger for instances that cannot be set up (left out of every statistic and listed in the report), --audit contamination checks (fix in problem statement, fix already in base, missing commit), --seed for reproducible intervals. src/suites.ts, test/suites.test.ts. NOT done: no full public benchmark has been run, no published results (needs Docker environments and model spend).
- **L5**: failure mining over .amness/traces: patterns clustered by normalised signature (finish rejected, loop, repair, denied, tool errors...), per-session trouble, cache hit rate; /report and amness traces; /report case and amness traces --case snapshot git HEAD into an eval task with your own held-out check; user cases may omit a solution (selftest then only checks the check fails). src/mining.ts, test/mining.test.ts.
- **L4**: traces now record run messages, every model message and full tool results (record option; chat sessions and --trace); amness replay <trace> feeds them through the current harness with stub tools and a scripted model and reports the guard/trim/cache-break/rejection differences; unchanged harness reproduces identically. src/replay.ts, test/replay.test.ts.
- **L7** (partly): the structural index with call/import graph (find_refs, impact, ranking by identifier overlap and centrality) exists and is tested; its benefit on real multi-file tasks is NOT yet measured (amness eval --cases with bug-in-a-mid-sized-repo; run: amness eval --variants full,full-index).
- **G10**: zero-dependency structural index (symbols, import graph with .js-for-.ts, index and python resolution, identifier usage; 12 languages by regex) rebuilt incrementally by mtime; repo_map, find_refs, impact tools offered when the repo has 25+ source files; a 45-file eval task. src/codeindex.ts, test/codeindex.test.ts.
- **G9**: models per role (explore, compact, review) via the models option and /models, a fallback model for overloaded or unreachable providers (withFallback; retryable errors only), subagent model keys. src/route.ts, test/route.test.ts. Per-step cache-aware routing is L6.
- **G8**: custom subagents from .amness/agents and .claude/agents (tools whitelist, model key, max-steps, isolation: worktree); task({description, agent}); writers share permissions, floor, sandbox, approvals and the ledger and are forced read-only in plan mode; per-call concurrency (readers parallel, writers alone); worktree agents hand back a saved patch applied with apply_patch({file}). src/agents.ts, src/worktree.ts, test/agents.test.ts. Parallel worktree agents with a merge gate are L13.
- **G7**: SKILL.md discovery in .amness/skills, .agents/skills, .claude/skills (project and home; precedence rules; malformed ones warned), names and descriptions only in the first message, skill tool loads the body and bundled files on demand (confined to the skill folder), tool only exists when skills exist, /skills. src/skills.ts, test/skills.test.ts.
- **G6** (partly): opt-in OS sandbox for sh and sh_start: macOS Seatbelt and Linux Bubblewrap (writes only in the project, temp and cache folders; .git and the rule files read-only; strict also cuts the network); refuses rather than downgrades when unavailable; /sandbox, --sandbox, sidebar indicator, yolo tip. Tested on macOS with real sandbox-exec; the bwrap path is built but untested here (no bwrap on this machine). src/sandbox.ts, test/sandbox.test.ts.
- **G5**: apply_patch (Codex envelope or unified diff; update/add/delete/move; anchors; all-or-nothing with per-hunk errors; judged file by file by permission rules), edit_file edits list (all-or-nothing) and a unique indentation-tolerant fallback that says so; TUI shows one diff per patched file; 2 new multi-file eval tasks (change-signature, move-constant). src/patch.ts, test/patch.test.ts.
- **L3** (partly): opt-in independent reviewer: acceptance criteria written in a fresh context before task-like messages and shown to the builder; before a finish is accepted a read-only reviewer (run_check limited to test/build/lint commands) judges the diff against them; findings go back, max two rounds, inconclusive never blocks; can use a different model; /reviewer, --review, eval variant full+review. src/review.ts, test/review.test.ts. Value on real tasks still to be measured (amness eval --variants full,full+review).
- **L2** (partly): stagnation detection from objective signals: failure counts parsed from test/build/lint output (Jest, pytest, Go, Cargo, Node runner, tsc, eslint, exit code fallback), first edits, new non-inverse changes, new reads (capped); reflection after K=8 stale turns, stop after 1.5K; 'stagnation' guard for ablation; stagnationTurns option. src/progress.ts, test/progress.test.ts. Not yet measured on a real model (eval variant full-stagnation).
- **L1** (partly): claims ledger (edits and commands with exit codes recorded from tool events) checks the finish summary: tests-pass needs a passing run after the last edit, build/typecheck claims need a matching command, 'changed file X' needs a recorded edit; rejected with specifics at most twice; audit line after accepted finish (files changed, tests after last edit, test files touched unprompted); 'ledger' guard for ablation; 2 new eval tasks (test-weakening-trap, partial-verify-trap). src/ledger.ts, test/ledger.test.ts. Measuring the false-done rate on a real model is still to do (amness eval --variants full,full-ledger).
- **G4**: sh_start / sh_read / sh_stop / sh_list with a 200 KB ring buffer, process-group kill, max 5, plan mode hides sh_start, same permission rules and floor as sh; sidebar PROCESSES section, /procs, cleanup on exit. src/procs.ts, test/procs.test.ts.
- **G14**: cycle detection (2-4 different calls repeating 3x) with a reflection-style refusal; repeat counting now ignores key order and whitespace and resets after any file edit, which also fixes a false positive (re-running the same test command after real edits was being blocked on the third time). src/harness.ts, test/loop.test.ts.
- **G12**: always-on JSONL trace per session (.amness/traces), optional OTLP/HTTP export with GenAI attributes (AMNESS_OTLP, --trace), cache-waste figure (tokens re-read at full price and estimated dollars) in /loop. src/trace.ts, test/trace.test.ts.
- **G3**: allow/ask/deny rules (sh(...) with per-piece compound handling, edit(...)/read globs) from project and user files; built-in floor that holds in yolo (no rm -rf of / ~ .., no force-push to main, no .git or policy-file edits, curl|sh and force-push always ask); project allow rules need approval; /permissions; 'always allow' in the approval dialog. src/permissions.ts, test/permissions.test.ts.
- **G2**: six events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop) via .amness/hooks.json and ~/.amness/hooks.json; block with exit 2, add context or rewrite args with stdout JSON; scrubbed env, timeouts, fail-open or failClosed; project hooks need approval of the exact file (headless: --trust-hooks); /hooks. src/hooks.ts, test/hooks.test.ts.
- **G1**: AGENTS.md (then CLAUDE.md, GEMINI.md) from the workspace root and the user folder load into the first message; a folder's own file is appended to the first read or edit there (once). Shown in /status. src/guidance.ts, test/guidance.test.ts.
- 2026-10-27: roadmap deepened with Track B (L1 to L14) from a second round of papers and engineering posts.

- **Measured on gpt-6-luna (2026-10-29)**: built-in suite baseline 96% / full 100% / full+review 100% (tokens per solved task 9.2k / 8.3k / 14.7k), adversarial suite 100% for full, full-taint and baseline. No detectable effect of any guard on these easy tasks, and the reviewer cost ~77% more tokens for no gain here. L2/L3/L9 stay `[~]`: they need harder tasks. Details in docs/evaluation.md.
- **Budget exhaustion fix (2026-10-29)**: a run that explored without closing hit the 300k cap with no answer. Added budget notes (50/75/90%), a final no-tools report before the cap, a 12-turn read-only check, and cached input counted at a tenth against the cap. Under the `wrapup` guard; scripted tests only. See docs/agent-loop.md.
- 2026-10-29 (end of day): added "Next up" with E1 to E13 (measurements) and G24 to G41 (build). First real-model results and the budget fix are in the entries above and docs/evaluation.md, docs/budgets.md.
- 2026-10-30: hard eval suite, /budget /lsp /approver, sidebar budget, running cards closed at turn end, OpenAI compactAt, CHANGELOG, require-sandbox CI check, subagent steps nested inside their card (parent ids), shared rate limiter (Retry-After, AIMD concurrency, quota errors not retried), maxConcurrent. See docs/budgets.md.
- 2026-10-30: plugins (C0): src/plugins.ts, PreModel/PostModel events, eval --plugin/--cases file.ts, /plugins, docs/plugins.md, examples/plugins/house-rules.ts; Track C added to the roadmap.
- 2026-10-30: docs rewritten at CEFR B1 level by writer agents against docs/writing-guide.md (every claim re-checked in the code; wrong or unverifiable statements fixed or marked), new getting-started.md and cookbook.md, README guide. Bug found while documenting: `amness run --help` started a model run (fixed).
- 2026-10-30 (Track C): C0 and C5 done; C1-C4, C6-C9, C11-C14 partly (see each row): plugin commands/scaffold/reload, finish gates and voting, policy as code with trace replay, loop strategies, context strategy, choosingModel, metrics and --gate, prompt registry, model/chaos/prompt/strategy variants, session grading, plugin capability scan. Left: C10 memory backends, loop-order replacement, pairwise judge, shadow mode, plugin install/isolation, split view.
- 2026-10-31: C10 memory backends (`memory` plugin field, MemoryBackend interface; run() now reports endTurn too), C4 model routing by function (`route` + `modelById`), C1 status lines in the sidebar, C9 `/prompt`, C12 `amness plugin add <file|https-url>`. Still open in Track C: replacing the turn order, pairwise judge / sequential testing / task weights, judge calibration, shadow mode, plugin install from npm and worker isolation, split-view model comparison.
- 2026-10-31: `strategy:spec-check` (a once-only finish gate that sends the model back through the spec) measured on spec-in-docs: 1/8 vs 0/8 for the default harness, not a real difference. CI: user namespaces are now allowed on the runner so the Linux sandbox tests run (they were silently skipped before). /reload-plugins asks for approval of an edited plugin.
- 2026-10-31: `amness bench` (src/bench.ts, cli/benchcli.ts, docs/bench.md): the same tasks and hidden checks through Amness, Amness with a finish gate, Claude Code (`claude -p`, with a clean-room `--bare` variant) and Codex (`codex exec`), or any command; configurable per contestant (command, args, stdin, model, env, timeout, parser), `--init/--check/--probe/--dry-run`; tested with fake tools and once end to end with Amness itself. NOT yet run against real Claude Code or Codex: the claude and codex presets and the Codex token parser are unverified until you run `amness bench --probe` on your machine. `amness run -` reads the task from stdin.
