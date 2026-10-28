# Roadmap

Two tracks. **Track A (G1 to G22)** closes the gaps found by comparing Amness with the main coding-agent harnesses. **Track B (L1 to L14)** is the plan to get ahead of them, drawn from recent papers (see [Sources](#sources) and each item's evidence note). Work through them in order; tick a box when the item is done **and** its acceptance check passes. Each item gets its own commit, tests, and a README line.

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
- [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804): editing strategy and action space matter; keep stuck detection and post-edit checks.
- [Harness design for long-running apps (Anthropic)](https://www.anthropic.com/engineering/harness-design-long-running-apps): planner, generator and separate evaluator; sprint contracts; resets vs compaction; remove scaffolding one piece at a time.
- [When Do Agent Loops Mistake Stagnation for Progress?](https://arxiv.org/abs/2607.25152): self-evaluation bias; externally grounded gating.
- [Harness Engineering for Self-Improvement (Lilian Weng)](https://lilianweng.github.io/posts/2026-07-04-harness/): what can be optimised, evaluators outside the loop, held-out gates.
- [EvoUndo](https://arxiv.org/abs/2608.28363) (recoverable self-modification), [AgentRouter](https://arxiv.org/abs/2609.22951) (per-step routing), [Code Isn't Memory](https://arxiv.org/abs/2606.22417) (structural index), [Engineering Reliable Coding Agents](https://arxiv.org/abs/2608.13867) (system-level reliability).

Several of these sources are blogs and disagree on details; verify against each tool's official docs before copying a behaviour.

## Done log

Newest first. When an item is finished, tick it above and add one line here with the commit.

- **G21** (partly): Docker image built and run in CI (passes); Windows job added but many tests fail there (POSIX shell, paths): not supported yet
- **G22** (partly): npm build to dist, pack/install/run smoke test in CI, tag-triggered publish workflow; NOT published (needs your npm token and a v* tag)
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
