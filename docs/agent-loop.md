# The agent loop, caching and where the design comes from

This page explains how Amness runs one turn of work, which checks keep a long run safe, and where the ideas come from.

In this page you will learn:

- what happens, step by step, from your message to the final answer
- which guards stop an agent that is stuck, and how to tune them
- how the claims ledger checks the agent's final summary
- how Amness keeps the prompt cache valid, and which sources the design follows

## Words used on this page

| Term | Meaning |
|---|---|
| Token | A small piece of text that a model reads or writes. One token is about four letters. |
| Context window | The most text a model can read in one request. The whole conversation must fit in it. |
| Cache | A copy of the start of your request that the provider keeps for a short time. Cached input costs much less than fresh input. |
| Guard | A rule in the loop that watches for a problem (a repeated call, no progress) and reacts. |
| Ledger | A record of what really happened: files edited, commands run, exit codes. |
| Hook | A command of yours that runs at a fixed point of the loop and can block a step or add text. |
| Subagent | A second agent that the main agent starts for one job. It has its own fresh context. |
| Budget | A limit on tokens (and sometimes time) for a run. |

## See how one turn works

**What it is.** A *turn* is one pass of the loop in `run()` in `src/harness.ts`. The agent asks the model what to do, runs the tools the model asks for, and repeats until the model calls `finish` or gives a plain answer.

**Why you would read this.** You can find out why a run stopped, or which guard sent a message to the model.

```mermaid
flowchart LR
  A["steer<br/>messages typed meanwhile"] --> B["budget<br/>check"] --> C["compact<br/>supersede · elide · handoff"] --> D["model call<br/>streaming"]
  D -->|tool calls| E["validate · approve ·<br/>schedule: reads in parallel,<br/>writes one at a time"]
  E --> F{"all failed?"}
  F -->|"3×: reflect, 6×: stop"| A
  F -->|no| A
  D -->|finish| G{"verify gate<br/>npm test"}
  G -->|rejected + feedback| A
  G -->|passes| H(["done"])
```

Each turn does these things in this order: steer, budget check, compaction, model call, tool calls, then the verification gate when the model calls `finish`.

### Example: one turn from your message to the answer

You type `Fix the failing test in src/math.ts` in the chat and press Enter. The agent edits one file, runs the tests, and finishes. The numbered steps below show where each part happens.

1. **You press Enter.** `handleKey()` in `cli/tui/app.ts` calls `submit()`. If the agent is already working, `submit()` puts your text in a queue instead. The loop reads that queue in step 5.
2. **The UI starts the turn.** `submit()` calls `dispatch()`, which calls `turn()` in `cli/tui/app.ts`. `turn()` expands `@file` mentions and resets the token budget (cap from your config, 60 minutes). It then calls `agent.chat()`.
3. **The agent prepares the request.** `chat()` in `src/code.ts` runs the `UserPromptSubmit` hook (`promptHooks`). It adds acceptance criteria when the reviewer is on (`withContract`), adds relevant memory notes, and builds the message list. It then calls `run()` of the harness.
4. **The loop starts a step.** `run()` in `src/harness.ts` first checks the abort signal.
5. **Steer.** `run()` calls `o.inbox()`. In the chat this is `drainQueue()` in `cli/tui/app.ts`. Each queued message joins the conversation.
6. **Budget.** `run()` reads `Budget.fraction` (class `Budget` in `src/harness.ts`). At 50%, 75% and 90% it appends a note. At 95% or more, or when another step would not fit, it makes a final report call and stops.
7. **Compaction.** If the transcript is longer than `contextBudget` (default 60,000 characters), `run()` calls `supersede()` and then `compact()`. Claude models skip this step (see the cache section). Before this, `makeHandoff()` runs if a context rollover is due.
8. **Model call.** `run()` checks for a cache break (`firstCacheBreak()`), runs the `PreModel` hook, and calls the model. Text streams to the UI through `onText`.
9. **Tool calls.** The model asks for `edit_file` and `sh`. Inside `run()`, `exec()` checks the arguments (`validate()` in `src/schema.ts`), runs the `PreToolUse` hook, checks repeated calls (`canonicalCall()`, `findCycle()`), and asks the permission rules and you for approval. Then it runs the tool. The edit and the shell command do not run at the same time, because they can change state.
10. **Results.** `condense()` shortens the output. `redact()` in `src/secrets.ts` masks secrets. The `PostToolUse` hook runs. For an edit, `Ledger.onEdit()` in `src/ledger.ts` records it. For a shell command, `Ledger.onCommand()` records the exit code.
11. **Checks after the tools.** `run()` updates the read streak, `ProgressTracker.observe()` in `src/progress.ts`, and the count of turns where every call failed.
12. **The next step.** The model sees the test result. It calls `finish` with a summary.
13. **The finish gate.** `exec()` runs the `Stop` hook, then `Ledger.check()`, then the `verify` command (built in `createCodeAgent()` in `src/code.ts`, run with `runShell()`), then the reviewer if it is on. If all pass, the loop emits an `audit` event and a `finish` event and returns.
14. **The answer reaches you.** `chat()` calls `memory.endTurn()` and returns. `turn()` saves the messages. Each loop event passed through `onEvent()` in `cli/tui/app.ts` into the block store (`cli/tui/blocks.ts`), and `draw()` in `cli/tui/full.ts` showed it on screen.

**Limits and common problems.**

- The exact step numbers differ from run to run. A plain-text answer without `finish` also ends a run, and then `finished` is `false` in the result.
- The loop stops after `maxSteps` (the code agent uses 60 in chat and 40 otherwise, unless you set it).
- Not every event appears in every run. Guards only speak when they fire.

**Related pages.** [Architecture](architecture.md), [Library](library.md), [Why: what Amness checks](why.md).

## Know what keeps long runs reliable

### Scheduling of tool calls

**What it is.** Read-only calls and subagent calls in one turn run at the same time, up to 5 (`MAX_PARALLEL` in `src/harness.ts`). Anything that can change state runs alone, in the order the model gave.

**How to use it.** Mark your own tool `readOnly: true` or `parallel: true` in `defineTool()`. A tool can also set `concurrent`, a function that decides per call.

**Limits.** The `task` tool (subagents) has its own limit of 3 running at the same time (`taskSlots` in `src/code.ts`). The rule that writing tools never overlap is tested in `test/loop.test.ts`. The limit of 3 subagents is not covered by a test that I found.

### Compaction in stages, cheapest first

**What it is.** Compaction makes the conversation shorter so it fits in the context window. Amness works in stages and starts with the cheapest:

1. **Condense each result as it arrives** (`condense()`). It removes terminal codes and progress redraws and collapses repeated lines. If the output is still longer than 6,000 characters, it keeps the first 40%, the last 30%, and up to 25 error-like lines from the middle.
2. **Drop repeated or expired output** (`supersede()`). An *expired* read is a read of a file that was edited afterwards. Both kinds are replaced by a short note.
3. **Elide old tool output** (`compact()`). Output over 300 characters in older messages is replaced by a note. The last 6 messages stay intact. The cut goes down to 70% of `contextBudget` in one go.
4. **Hand off to a fresh context** (`makeHandoff()`). The model writes a note, and the run continues from the task plus that note. For the code agent, this happens when the last prompt passes 120,000 tokens or the transcript passes 500,000 characters. You can change this with the `rollover` option.

**Why.** Every change to old messages breaks the provider's cache from that point on. One large cut every few turns costs less than a small cut every turn.

**Example.** Type `/loop` in the chat. It lists each model turn, the guards that fired, and how much was trimmed.

**Limits.** Stages 2 and 3 do not run for models that set `appendOnly` (Claude). Stage 4 works for every provider. A hook on `PreCompact` can veto stages 2 and 3.

### Post-edit check

**What it is.** A fast command, such as a typecheck, that runs after every edit.

**How to use it.**

```
/check npm run typecheck
```

In headless mode, use `amness run --check "npm run typecheck" "your task"`. In the library, use the `check` option.

**Example.** Only a failure is shown to the model. It is appended to the edit result as `[post-edit check ... failed; fix this before moving on]`. The model sees the mistake one step after it makes it.

### Guards

A *guard* watches the loop. You can switch each one off with the `off` option (see the list of names below).

| Guard (`off` name) | What it does |
|---|---|
| `loop` | Stops the same call (after normalising it) from running a third time while nothing was edited in between. Running tests again after an edit is fine. It also finds cycles: 2 to 4 different calls that repeat three times, such as an edit flipped back and forth around a test run. |
| `nudge` | If the model says what it will do ("I'll run the tests") instead of doing it, the loop tells it to act. At most 2 times. |
| `wrapup` | Warns 3 steps before the step cap. Adds budget notes. Makes the final report. Checks for 12 read-only turns in a row. |
| `stuck` | After 3 turns in a row where every tool call failed, asks the model to reflect. After 6, stops the run. |
| `stagnation` | See the next section. |
| `compact`, `condense`, `schedule`, `ledger`, `review`, `redact` | Switch off the matching feature. |

`off` takes a list of these names. The type is `Guard` in `src/harness.ts`. With `amness replay <trace.jsonl> --off loop,stuck` you can replay a recorded session with some guards off. See [Evaluating the harness](evaluation.md).

### Stagnation is judged from signals you can check

**What it is.** A loop that keeps acting while nothing measurable improves gets a structured reflection after 8 such turns and a clean stop after 12. The code is `ProgressTracker` in `src/progress.ts`.

"Improves" means one of these:

- The count of failing tests, errors or lint problems reaches a new low. Amness reads the count from output of Jest, pytest, Go, Cargo, the Node test runner, `tsc` and `eslint`, among others (`countFailures()`).
- A file is edited for the first time.
- An edit adds a change that is not the undo of an earlier edit.
- The agent reads something new (counted at most 15 times per run).

The model's own confidence counts for nothing.

**How to tune it.** Set `stagnationTurns` (default 8; the stop comes at 8 plus half of 8, which is 12). Set it to `0`, or use `off: ["stagnation"]`, to switch it off. Tested in `test/progress.test.ts`.

**Limits.** The count is read from text output. If a tool prints failures in a format Amness does not know, it falls back to the exit code and counts 1 failure.

### The claims ledger checks the final summary

**What it is.** The ledger (`Ledger` in `src/ledger.ts`) records what really happened: which files were edited, which commands ran, and their exit codes. When the model calls `finish`, `Ledger.check()` compares the summary with this record.

**What it checks.**

- "All tests pass" needs a passing test run after the last edit.
- "The build is clean" needs a successful build, typecheck or lint after the last edit. A passing test run also counts.
- A file named as changed must have been edited. This check is skipped if a shell command wrote files (`sed -i`, `>`, `mv` and similar).
- If your `verify` command already gates `finish`, the test and build claims are not checked a second time.

A mismatch is rejected with the reason. This happens at most twice, so it cannot lock the loop. After that, the loop accepts the summary and records a `Ledger` hook event.

**Example.** Accepted runs end with an `audit` event: files changed, whether tests passed after the final edit, and notes. A note appears when test files changed although your task did not mention tests, when more than 8 files changed, or when no test command ran. Tested in `test/ledger.test.ts`.

**Limits.** The checks use word patterns in English. A summary in another language, or an unusual test command, may not match. You can tell the ledger your own test command through `verify` or `check`. Agents that judge their own work accept plausible progress as real progress ([When Do Agent Loops Mistake Stagnation for Progress?](https://arxiv.org/abs/2607.25152)). The ledger is a cheap outside check.

### Independent reviewer (opt-in)

**What it is.** A second agent in a fresh context. It writes acceptance criteria before the work (at most 7) and checks the diff before `finish` is accepted.

**Why.** Builders overpraise their own work, and a separate judge is easier to make sceptical than a builder is to make self-critical ([Anthropic's long-running harness write-up](https://www.anthropic.com/engineering/harness-design-long-running-apps)).

**How to use it.** Type `/reviewer on` in the chat, or add `--review` to `amness run`.

**Details.**

- The reviewer can read files and run only the project's own test, build and lint commands. It cannot edit.
- It runs after the ledger and after your `verify` command.
- Findings go back to the builder. After two rounds the work is accepted and flagged. A verdict that cannot be used never blocks.
- It can use another model: `review: { model }`.

**Limits.** It costs extra model calls. The number per task is not verified here. It is off by default. To measure it, run `amness eval --variants full,full+review`. See [Evaluating the harness](evaluation.md).

### Done means verified

`finish` passes through your `verify` gate (for example your tests or build). It is rejected with feedback until the command exits with 0.

## Understand the prompt cache

**What it is.** Cached input costs a fraction of fresh input. Amness keeps the start of each request identical from turn to turn so the cache stays valid.

**What Amness does.**

- **Append-only by default.** Old messages change only when the window needs it, in one cut well below the budget. New information (steering messages, memory notes) goes at the end.
- **Claude is append-only always.** The Claude adapter sets `appendOnly`, so the harness never edits past turns for Claude (`src/anthropic.ts`, `src/harness.ts`). Context rollover still works.
- **Stable request shape.** Tool definitions are sorted by name. The memory index is added once per conversation. OpenAI requests carry a `prompt_cache_key` and ask for `24h` cache retention. If a model refuses these fields, the adapter drops them (`src/openai.ts`).
- **Keep-alive (opt-in).** Claude drops a cached prefix after about 5 idle minutes. `/keepwarm on` re-sends the conversation with a 16-token output cap after 270 seconds of idle time, at most 3 times per break. This costs a cache read instead of a cold read. It is off by default because it spends tokens while you are away. It applies to Claude only.
- **You can see it.** `/loop` marks every turn where the start of the request changed (for example "earlier history was rewritten at message 14" or "the tool list changed"). The usage panel shows the cache hit rate. `amness eval` reports it per variant.

**Limits and common problems.**

- A change in the tool list, such as a mode switch or a loaded tool, breaks the whole cache once.
- The cost effect of these choices is from the papers below. Amness has not measured it on a real model yet.

**Related pages.** [Budgets and subagents](budgets.md), [Providers and models](providers.md).

## Learn where these choices come from

Recent work on coding-agent loops points the same way. The loop follows it where this can be done without training a model.

- [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804) (2026): cheap rule-based elision before any LLM summary gave the lowest cost. A recall tool for elided content was almost never used, so Amness has none. Stuck detection and light post-edit checks are cheap ways to stop wasted turns.
- [AgentDiet](https://arxiv.org/abs/2509.23586) (trajectory reduction): removing useless, redundant and *expired* information cut input tokens by 40-60% with unchanged results. This is the source of the expired-read and repeated-call rules.
- [CoACT](https://arxiv.org/abs/2607.02911) and [SWE-Pruner](https://arxiv.org/abs/2601.16746): reads use most of the tokens. Compression must keep what the next action needs, and earlier messages stay untouched so the cache stays valid. Amness uses rules for this. The papers use trained compressors, which would add a dependency.
- [Don't Break the Cache](https://arxiv.org/abs/2601.06007) (prompt caching for long-horizon agents): caching cut API cost by 41-80% across OpenAI, Anthropic and Google, but naive full-context caching can hurt. Put dynamic content at the end, avoid dynamic tool lists, and keep dynamic tool results out of the cached prefix. [Keeping the Cache Warm Pays](https://arxiv.org/abs/2607.19214) motivates the longer OpenAI retention and the opt-in Claude keep-alive.
- Memory: [Infini Memory](https://arxiv.org/abs/2606.10677) (plain-text topic documents, lexical retrieval, merge and split maintenance, recency resolves contradictions; its structural maintenance mattered most in its ablations), [REALM](https://arxiv.org/abs/2609.16053) (retrieval feeds back into how memory is organised, which is why Amness records use and ranks by it) and the strategic-forgetting work ([SF-AMS](https://arxiv.org/abs/2607.22562), [FSFM](https://arxiv.org/abs/2604.20300)). Amness uses plain files: word-based retrieval plus optional embeddings, merge maintenance (`/memory consolidate`), a light note graph, ranking by outcome, and forgetting you can undo. "Learning" here means simple counts (wins and losses per note), not a trained model. There is no graph database.
- A [source-code study of eleven coding agents](https://arxiv.org/html/2609.00006v1): read-only tools run at the same time, tools that change things run one at a time.

The percentages above are the papers' results on their own benchmarks. They are not measurements of Amness. Use the eval runner (`evaluate`) with the guards switched on and off to measure them on your own tasks. Whether a source was read in full or only seen as a search snippet is marked on [Budgets and subagents](budgets.md).

## Know what the budget does to the loop

The loop also watches the token budget: notes at 50%, 75% and 90%, a final report instead of a bare stop, a check for 12 read-only turns, and slices for subagents. These are explained, with sources, in [Budgets and subagents](budgets.md). They are tested with scripted models. Whether they reduce exhausted runs on real tasks is not measured.

## Next steps

- [Budgets and subagents](budgets.md): choose a budget and read the budget notes.
- [Architecture](architecture.md): see which file does what.
- [Evaluating the harness](evaluation.md): measure a guard on your own tasks.
- [Plugins](plugins.md): add your own loop rules.
