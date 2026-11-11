# Skills for working on Amness

Claude Code loads these skills when a task matches their description. The first four are ours. The others are copied unchanged from MIT-licensed repositories (each folder has its `LICENSE` and a `SOURCE.md` with the commit).

## Ours

| Skill | Use it to |
|---|---|
| `add-feature` | add a tool, guard, slash command or provider, with tests, docs and the roadmap tick |
| `check` | run the type check and tests the way CI does |
| `release` | cut and stage an npm release |
| `write-docs` | write docs in plain English (CEFR B1) |

## Building the harness

Each one matches a part of Amness. Read the matching code first. A skill gives a checklist and common failure modes, not facts about this code.

| Skill | Source | The part of Amness it helps with |
|---|---|---|
| `harness-engineering` | Agent-Skills-for-Context-Engineering | the loop as a whole: locked and editable surfaces, durable logs, pruning, rollback (`src/harness.ts`, evaluation campaigns) |
| `context-compression` | Agent-Skills-for-Context-Engineering | compaction, handoff notes, pinned rules (`src/context.ts`, `makeHandoff`) |
| `context-optimization` | Agent-Skills-for-Context-Engineering | prompt-cache prefix, observation masking, token budgets (cache breaks, `readdelta`, `condense`) |
| `context-degradation` | Agent-Skills-for-Context-Engineering | diagnosing lost-in-the-middle, context poisoning and clash in long runs |
| `tool-design` | Agent-Skills-for-Context-Engineering | tool descriptions, schemas, error messages the model can act on (`src/code.ts` tools, `argfix`) |
| `multi-agent-patterns` | Agent-Skills-for-Context-Engineering | subagents, explorer, models per job, the recovery ladder (`src/route.ts`, `src/ladder.ts`) |
| `memory-systems` | Agent-Skills-for-Context-Engineering | memory notes, ranking, consolidation (`src/memory.ts`) |
| `self-improvement-loops` | Agent-Skills-for-Context-Engineering | `amness tune`, failure mining, harness checks that feed fixes |
| `evaluation` | Agent-Skills-for-Context-Engineering | `amness eval`, held-out checks, regression suites, baselines |
| `advanced-evaluation` | Agent-Skills-for-Context-Engineering | LLM judges: the reviewer, tournament selection, judge bias |
| `agent-introspection-debugging` | ECC | reading a failed agent run (a trace or a Studio run) before changing anything |
| `systematic-debugging` | superpowers | root cause before a fix, for any bug or failing test |
| `verification-before-completion` | superpowers | run the command and read its output before saying "done" |

`excalidraw-diagram` (diagrams in `docs/diagrams/`) is installed locally only: its source has no licence file.

## What the evidence says about skills

Skills do not help everywhere. Two 2026 studies found that a skill helps on some tasks and models and not on others, and that it makes every prompt longer ([Agent Skill Evolution, arXiv 2610.04832](https://arxiv.org/html/2610.04832v1); [WebDev-Skills-Bench, arXiv 2608.23067](https://arxiv.org/abs/2608.23067), both seen as abstracts and snippets only). So this folder keeps only skills that match a part of this project, one per job, and no general collections.
