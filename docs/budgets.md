# Budgets, exploration and subagents

Why runs used to end with "token budget exhausted" and nothing to show, what the vendors and papers recommend, and what Amness does about it. Sources marked *read* were fetched and read; *snippet* means only a search summary was seen.

## What went wrong

A question like "explore the codebase" had no natural end: the model kept reading, spawned several deep explorers at once (one even with a wrong agent name, which failed and was retried), every request re-sent the whole history, and the 300k cap cut the run off with no answer.

## What the sources say

| Source | Finding | Used here |
|---|---|---|
| [Claude task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets) (*read*) | An advisory token budget for the whole agentic loop; the model sees a running countdown and "finishes gracefully". It counts what the model *sees* (new content), not the re-sent history. Set it once: changing it each request breaks the prompt cache. A budget that is too small for the task can make the model refuse or stop early. Minimum 20,000; beta; not Claude Code. | Opt-in `taskBudget` for Claude (below). |
| [BATS, arXiv 2511.17006](https://arxiv.org/abs/2511.17006) (*read*) | A per-turn budget tracker, with behaviour tiers (high / medium / low / critical remaining), improved search agents' accuracy and cut cost (a tracker at budget 10 matched plain ReAct at 100 with ~31% lower cost, on web-search tasks, not coding). | Budget notes at 50 / 75 / 90%. |
| [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (*read*) | Models misjudge effort, so put scaling rules in the prompt (simple fact: 1 agent, 3-10 tool calls; comparison: 2-4 agents, 10-15 calls each). Vague subagent briefs cause duplicated work: give an objective, output format, tool guidance and boundaries. Token use explains ~80% of performance variance; multi-agent runs use ~15× the tokens of chat and suit parallel, high-value work, "domains like most coding" less so. | Effort rules in the system prompts; brief requirements in the `task` tool; subagents limited. |
| [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (*read*) | Just-in-time retrieval (paths, grep) over preloading; clear old tool results; subagents may burn tens of thousands of tokens but should return a condensed 1,000-2,000 token result. Accuracy falls as context grows ("context rot"). | Subagent reports clipped to 8,000 characters; existing tool-result elision. |
| [OpenAI Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) (*read*) | Subagents are for read-heavy parallel work, cost more tokens than one agent, return summaries not raw output; a cap on concurrent threads; be cautious with parallel writers. | At most 3 `task` calls at once. |
| [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction) (*snippet*) | Server-side compaction via `context_management` with a `compact_threshold`. | Not used yet. |
| Blogs on "exploration burn" (e.g. [First-Touch Tool Burn](https://tianpan.co/blog/2026/04/23/first-touch-tool-burn-agent-exploration-budget), *snippet*) | Claim that reading dominates agent spend (figures from 47% to 87%), and propose a cap on reads before the agent must state a plan. Numbers unverified. | The 12-read-only-turns check is the same idea. |

## What Amness does now

1. **Prompt rules, not just limits** (Anthropic): the system prompts say how many tool calls a question deserves and when a subagent is worth its cost.
2. **The model sees its budget** (BATS): notes at 50%, 75% and 90% of the cap, appended at the end so the cache survives.
3. **Never end empty-handed**: when another step plus a summary would not fit, one last call without tools asks for what was found, the state of the work and what remains.
4. **Exploration check**: after 12 turns of only reading, the model is told to answer or act.
5. **Subagents are bounded**: the explorer gets at most 20% of what is left (80k tokens, about 12 tool calls, 14 steps); custom agents 30% (150k); at most 3 run at once; reports are clipped; a wrong agent name uses the explorer instead of failing. Their spending counts against the main budget.
6. **The cap measures cost**: cached input counts at a tenth, so a long cached session is not "exhausted" early.
7. **Claude's own countdown, opt-in**: `"taskBudget": 150000` in the config (at least 20,000) sends `output_config.task_budget` with the `task-budgets-2026-03-13` beta header on models that support it (Opus 4.7+, Sonnet 5.5, Haiku 5.5, not Sonnet 5). Set once, never changed per request, advisory only: Amness's own cap still applies. Size it from your real usage; a budget that is too small makes Claude scope the task down or stop early.

All of this is tested with scripted models and fake SDK clients. None of it has been measured on a real model for fewer exhausted runs; the eval runner can do that once there are exploration-style tasks in the suite.

## Model-agnostic by design

Everything except item 7 lives in the harness and works the same for OpenAI, Claude and local models: the notes and final report are ordinary messages, the subagent limits are ours, and the prompt rules are plain text. Where a server reports no token usage (common with local servers), the harness estimates it at about 4 characters per token so the cap, notes and final report still work; those figures are marked `estimated`. Only the opt-in `taskBudget` is Claude-specific, and it is ignored for other providers and unsupported Claude models.

## Not done, and why

- **OpenAI server-side compaction** is now an option (`"compactAt": 150000` in the config; Responses API on official hosts only): the request carries `context_management` with that threshold, and input before the newest compaction item is no longer re-sent. Tested at the wire level only. Not measured: it is unknown yet whether it beats our own staged trimming, and it is off by default.
- **A hard cap on reads in the tool layer** (stop the read tool after N reads until a plan is stated): proposed in blogs, unverified, and risky for legitimate large reads. The nudge comes first; measure before making it a hard stop.
- **Exploration that returns only file paths and line ranges** (a paper named FastContext is cited in a blog, *snippet*, unverified): not implemented.
