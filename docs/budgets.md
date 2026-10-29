# Budgets, exploration and subagents

This page explains why runs used to end with "token budget exhausted" and no answer, what the vendors and papers advise, and what Amness does now.

In this page you will learn:

- how to choose a token budget and what you see when a run hits it
- what the budget notes, the final report and the subagent slices do
- how Amness stays under the provider's rate limits
- which sources were read and which were only search snippets

A *token* is a small piece of text that a model reads or writes. One token is about four letters. A *budget* is the most tokens a run may use.

## Choose a budget

**What it is.** The budget is a cap on the tokens for one turn of the chat, or for one headless run. The default is 300,000 tokens (`maxTokens` in `cli/config.ts`).

**Why you would change it.** A small budget stops a run early. A large budget lets a lost agent spend more before it stops.

**How the cap counts.** The cap counts cached input at one tenth of its size, because cached input costs about that much and a long session reads its whole history again on every turn (`Budget.effective` in `src/harness.ts`). The token count shown on screen is not changed. Where a server reports no token usage, Amness estimates about 4 characters per token and marks the figure `estimated`.

**How to set it.**

1. In the chat, type `/budget` to see the cap and what the last turn used.
2. Type `/budget 500k` to change it. You can write `500k`, `1m` or `400000`. The minimum is 10,000.
3. In headless mode, add `--max-tokens 500000` to `amness run`.
4. To keep the value, set `"maxTokens"` in `~/.amness/config.json`.

**Advice.** These values are starting points from how the code behaves. They are not measured on real tasks.

| Task | Starting budget | Why |
|---|---|---|
| A question about one file or one function | 100,000 to 150,000 | The prompt rules ask for 3 to 10 tool calls for this kind of question. |
| A bug fix with tests | 300,000 (the default) | One logged run of a broad question on a 300,000 cap used 132,000 (see below). Fixes with test runs cost more per step. |
| A survey of a large code base, or a refactor over many files | 500,000 to 1,000,000 | Subagents use part of the budget. Their cost counts against yours. |
| An unattended run in CI | The value you can afford, not more | The agent stops at the cap, so the cap is your worst-case cost. |

Rules of thumb:

- Start with the default. Look at the budget line in the sidebar or in `/budget` after the first turn. Then raise or lower the cap.
- Do not set the cap very low. At 50% the model is told to stop broad reading, so a small cap makes the agent give up exploration early.
- If a big task keeps hitting the cap, split it. Ask for the plan in one turn and for each part in a later turn. Each chat turn gets a fresh budget.
- Use `/loop` or `/tokens` to see where the tokens went before you raise the cap.

**Time limits.** The chat also has a time cap of 60 minutes per turn. `amness run` has no time cap. The classic menu mode uses 30 minutes.

### Example: what you see when the budget stops a run

When the cap is reached, or when one more step plus a summary would not fit, the loop makes one last call without tools. It asks the model what it found, the state of the work and what remains. You get that text instead of a bare error.

In the chat, a warning line appears with the first line of the result. The result text looks like this (the numbers and the report are an example built from the format in `src/harness.ts`, not a captured run):

```
stopped: token budget exhausted (301204/300000)

I read the router and the rate-limit gate. The retry logic is in
src/ratelimit.ts. I did not read the OpenAI adapter yet.
Left to do: check how src/openai.ts handles a 429.
```

If the loop sees that the next step would not fit, the first line is `stopped: budget nearly exhausted` instead.

In headless mode with `--json`, the last line is a result object with `"finished": false` and `"stopped": "budget"`. The exit code is 1. Here `tokens` is the raw count, before the cached-input discount.

**What to do next.** Raise the cap with `/budget`, or send a message such as "continue with the OpenAI adapter". The conversation keeps its history, so the agent continues from the report.

**Limits and common problems.**

- The final report is one more model call. If that call fails, the result has only the `stopped:` line.
- The run counts as not finished (`finished: false`), even if the report is a good answer.
- Time budgets give a similar message: `stopped: time budget exhausted (...)`.

**Related pages.** [The agent loop](agent-loop.md), [Using the chat](usage.md), [Headless and CI](headless.md).

## Understand why runs ran out of budget

A question like "explore the codebase" had no natural end. The model kept reading. It started several deep explorers at once, and one used a wrong agent name, which failed and was retried. Every request sent the whole history again. The 300,000 cap then cut the run off with no answer.

## Read what the sources say

Sources marked *read* were fetched and read. *Snippet* means only a search summary was seen.

| Source | Finding | Used here |
|---|---|---|
| [Claude task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets) (*read*) | An advisory token budget for the whole agentic loop. The model sees a running countdown and "finishes gracefully". It counts what the model *sees* (new content), not the history that is sent again. Set it once: changing it on each request breaks the prompt cache. A budget that is too small for the task can make the model refuse or stop early. Minimum 20,000. Beta. Not Claude Code. | Opt-in `taskBudget` for Claude (below). |
| [BATS, arXiv 2511.17006](https://arxiv.org/abs/2511.17006) (*read*) | A per-turn budget tracker, with behaviour tiers (high, medium, low, critical remaining), improved the accuracy of search agents and cut cost. A tracker at budget 10 matched plain ReAct at budget 100 with about 31% lower cost. The tasks were web search, not coding. | Budget notes at 50%, 75% and 90%. |
| [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (*read*) | Models misjudge effort, so put scaling rules in the prompt (simple fact: 1 agent, 3-10 tool calls; comparison: 2-4 agents, 10-15 calls each). Vague subagent briefs cause duplicated work: give an objective, an output format, tool guidance and boundaries. Token use explains about 80% of performance variance. Multi-agent runs use about 15 times the tokens of chat. They suit parallel, high-value work, and "domains like most coding" less. | Effort rules in the system prompts. Brief requirements in the `task` tool. Subagents are limited. |
| [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (*read*) | Fetch what you need when you need it (paths, grep) instead of loading everything. Clear old tool results. Subagents may use tens of thousands of tokens but should return a short result of 1,000 to 2,000 tokens. Accuracy falls as the context grows ("context rot"). | Subagent reports are clipped to 8,000 characters. Old tool results are elided. |
| [OpenAI Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) (*read*) | Subagents are for read-heavy parallel work. They cost more tokens than one agent. They return summaries, not raw output. There is a cap on concurrent threads. Be careful with parallel writers. | At most 3 `task` calls run at once. |
| [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction) (*snippet*) | Server-side compaction through `context_management` with a `compact_threshold`. | Optional `compactAt` (see "Not done, and why"). |
| Blogs on "exploration burn", for example [First-Touch Tool Burn](https://tianpan.co/blog/2026/04/23/first-touch-tool-burn-agent-exploration-budget) (*snippet*) | A claim that reading uses most of an agent's spend (figures from 47% to 87%), and a proposal to cap reads before the agent must state a plan. The numbers are not verified. | The check for 12 read-only turns is the same idea. |

## Know what Amness does now

1. **Prompt rules, not only limits** (Anthropic). The system prompts say how many tool calls a question deserves and when a subagent is worth its cost.
2. **The model sees its budget** (BATS). At 50%, 75% and 90% of the cap, a note is added at the end of the conversation. The cache stays valid, because nothing earlier changes. The 50% note says to stop broad exploration. The 75% note says to produce the result. The 90% note says the next reply must be the result.
3. **Never end empty-handed.** At 95% of the cap, when the cap is reached, or when another step plus a summary would not fit, one last call without tools asks what was found, the state of the work and what remains.
4. **Exploration check.** After 12 turns in a row that only read, the model is told to answer (if the task is a question) or start (if it is a change), or to name exactly what is still missing. It repeats after another 12.
5. **Subagents are bounded** (next section).
6. **The cap measures cost.** Cached input counts at a tenth.
7. **Claude's own countdown (opt-in).** `"taskBudget": 150000` in the config (at least 20,000) sends `output_config.task_budget` with the `task-budgets-2026-03-13` beta header. It works for the Claude models that the adapter lists as supported: Fable, Mythos, Opus 4.7, 4.8 and 5, Sonnet 5.5 and Haiku 5.5. It does not work for Sonnet 5, Opus 4.6, Sonnet 4.6 or Haiku 4.5 (`src/anthropic.ts`). It is set once and never changed per request. It is advice for the model only: Amness's own cap still applies. Choose the size from your real usage. A budget that is too small makes Claude narrow the task or stop early.

All of this is tested with scripted models and fake SDK clients (for example `test/features.test.ts`). None of it is measured on a real model for fewer exhausted runs. The eval runner can measure this once there are exploration-style tasks in the suite.

### Subagent slices

**What it is.** A subagent gets a slice of the budget, not the whole budget. `Budget.slice(share, max)` in `src/harness.ts` gives a subagent at most `share` of what is left, and no more than `max` tokens. Everything the subagent spends also counts against the main budget.

| Subagent | Share of what is left | Token limit | Other limits |
|---|---|---|---|
| Read-only explorer (built in) | 12% | 60,000 | 14 steps. The prompt says it has about 12 tool calls and should answer in under 300 words. |
| Custom agent (from `.amness/agents/`) | 25% | 120,000 | Its own `maxSteps`. |

Other limits (`src/code.ts`):

- A request may start at most 6 subagents (`MAX_SUBAGENTS_PER_REQUEST`). More return an error that tells the lead to work with what it has.
- At most 3 `task` calls run at the same time.
- Reports are clipped to 8,000 characters.
- Every report ends with a line such as `[subagent used about 3k tokens; the budget for this request is 40% used]`, so the lead can decide to stop delegating.
- A `task` call with an agent name that does not exist uses the read-only explorer and says so, instead of failing.

Inside its slice, a subagent gets the same budget notes and final report. An explorer that runs out returns what it found, not an error. Tested in `test/agents.test.ts` and `test/features.test.ts`.

**Limits.** An older version of this page said 20% and 80,000 tokens for the explorer, and 30% and 150,000 for custom agents. Those numbers were out of date. The values in the table match the code.

## What went wrong in the second report, and the fix

A "survey the whole codebase" run stopped at "budget nearly exhausted" while the display said 46% used. There were three bugs.

1. The step-cost estimate behind the early final report was the change in the shared budget. That also contains what the subagents spent in the meantime, so a step that ran three explorers looked very expensive. It now uses the cost of the lead's own last request.
2. Subagent budget notes were drawn as red errors, and every nudge was labelled "nudged the model to act instead of describing". Now nudges say what happened, subagent notes are not shown, and the final report is shown as a normal answer.
3. Nothing limited how many subagents a request could start. Now a request may start at most 6 subagents, explorers get a smaller slice, and every subagent report ends with what it cost.

After the fix, the same kind of request on `gpt-6-luna` (300,000 cap) finished in 83 seconds with a full answer. It used 132,000 of the 300,000 (cached input counted at a tenth; 234,000 raw). Two subagents wrapped up inside their slices. This was one run. It is not a measurement.

## Rate limits (requests and tokens per minute)

Several agents that share one API key (the lead, up to three explorers, the reviewer) can go over the per-minute limits. Failed requests count toward the limits too. A *429 error* is the answer a provider sends when you are over a limit.

What the vendors say ([OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [Claude rate limits](https://platform.claude.com/docs/en/api/rate-limits), both *read*):

- Wait at least the time in the `Retry-After` header, plus a small random delay (jitter). When the header is missing, use exponential backoff with jitter. Cap the number of attempts and the total wait. Do not retry quota or spend-cap errors, because they also arrive as 429. If you retry yourself, do not also let an SDK retry.
- Limits are enforced over short windows. A limit of 60 requests per minute can mean one request per second. A sharp rise in traffic can trigger "acceleration" 429 errors, so ramp up step by step.
- Claude counts only uncached input toward its input-tokens-per-minute limit, and `max_tokens` does not count toward its output limit. OpenAI counts the larger of `max_tokens` and the estimated request size, so keep `max_tokens` near the output you expect.

What Amness does (`src/ratelimit.ts`, for every provider, shared by all agents in the process):

1. One gate for each endpoint and key limits the requests in flight. The ceiling is 4 by default (`maxConcurrent` in the config). The gate starts at 2 and adds one after three successes, so traffic ramps up step by step.
2. On a 429 that waiting can fix, every caller pauses for the server's `Retry-After` time (or an exponential backoff of up to 60 seconds, with jitter). The gate halves its concurrency, like TCP congestion control. The chat tells you: `rate limited by the provider: waiting 12s, then retrying (attempt 1); 2 requests at a time for now`.
3. These cases are not retried, and the error reaches you: quota, billing and spend-cap errors; an abort; a requested wait longer than two minutes; and more than six retries.
4. The OpenAI adapter does not retry 429 by itself when the gate is on (`externalRetry`). It still retries timeouts and 5xx errors, and it honours `Retry-After`.

**How to use it.** If you see rate-limit messages often, lower the ceiling in `~/.amness/config.json`:

```json
{ "maxConcurrent": 2 }
```

**Limits and common problems.** Tested with fake models and clocks, and end to end against a local HTTP server that returns 429 with `Retry-After` (`test/ratelimit.test.ts`). The limit of 3 subagents at once is tested too (`test/agents.test.ts`). Not yet seen with a real provider 429. Evals ran slower than expected when many sessions ran at once. That is the situation this gate exists for.

## See subagents in the UI

A subagent's steps used to be drawn as loose lines in the transcript, mixed together when explorers ran in parallel. Now every event carries the id of the `task` call that started it (`parent`).

- **Full-screen view.** The steps live inside their card. While the subagent runs, the card shows the newest three steps. When it is done, the card shows a one-line summary such as "12 steps · 7 files read · 4 searches". Open the card to see all steps.
- **Inline view.** One live line for each subagent shows its newest step and step count.
- An interrupted or failed turn closes every card that was still running.

## Know that this works with any model

Everything except item 7 lives in the harness and works the same for OpenAI, Claude and local models. The notes and the final report are ordinary messages. The subagent limits are Amness's own. The prompt rules are plain text. Where a server reports no token usage, the harness estimates it, so the cap, the notes and the final report still work. Only the opt-in `taskBudget` is specific to Claude. Other providers and unsupported Claude models ignore it.

## Not done, and why

- **OpenAI server-side compaction** is an option: set `"compactAt": 150000` in the config. It works on the Responses API on official hosts only. The request carries `context_management` with that threshold, and input before the newest compaction item is no longer sent again. Tested at the wire level only. Not measured: it is unknown whether it beats Amness's own staged trimming. It is off by default.
- **A hard cap on reads in the tool layer** (stop the read tool after N reads until the agent states a plan): proposed in blogs, not verified, and risky for legitimate large reads. The nudge comes first. Measure before making it a hard stop.
- **Exploration that returns only file paths and line ranges** (a paper named FastContext is cited in a blog, *snippet*, not verified): not implemented.

## Next steps

- [The agent loop](agent-loop.md): see where the budget check sits in each turn.
- [Using the chat](usage.md): the `/budget`, `/loop` and `/tokens` commands.
- [Headless and CI](headless.md): `--max-tokens` and exit codes.
- [Providers and models](providers.md): OpenAI, Claude and local models.
- [Evaluating the harness](evaluation.md): measure what a guard is worth.
