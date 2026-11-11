# Skills for working on Amness

Claude Code loads a skill when a task matches its description. Each skill here is either written for this project or kept because it adds knowledge our code and docs do not have.

## Written for Amness

| Skill | Use it to |
|---|---|
| `add-feature` | add a tool, guard, slash command or provider, with tests, docs and the roadmap tick |
| `check` | run the type check and tests the way CI does, and report with evidence |
| `release` | cut and stage an npm release |
| `write-docs` | write docs in plain English (CEFR B1) |
| `measure-a-change` | decide whether a harness change helps before keeping it: claim first, smallest setup, honest size, fair comparison |
| `read-agent-run` | find why a run failed (config line, result, tests, steps, harness checks) and whether the cause is the harness, the model, the task or the setup; `steps.py` prints a run as steps |
| `update-diagrams` | change a picture in `docs/diagrams/` so it stays readable and true to the code |

## Kept from other projects (MIT, copied unchanged; each folder has `LICENSE` and `SOURCE.md`)

| Skill | Source | Why it is here |
|---|---|---|
| `systematic-debugging` | superpowers | root cause before a fix; none of our skills covers the debugging method |
| `tool-design` | Agent-Skills-for-Context-Engineering | descriptions, parameters and error messages a model can act on; `add-feature` covers the mechanics, not this |
| `context-compression` | Agent-Skills-for-Context-Engineering | risks of summaries (invented facts, lost paths and names, losses that add up over repeated compactions) to check when changing compaction or handoff notes |

## Removed after review (2026-11-12)

Copied the same day, then removed because they repeated what Amness already does or rarely applied here: `advanced-evaluation`, `agent-introspection-debugging`, `context-degradation`, `context-optimization`, `evaluation`, `harness-engineering`, `memory-systems`, `multi-agent-patterns`, `self-improvement-loops`, `verification-before-completion`. The useful parts of `evaluation`, `harness-engineering`, `agent-introspection-debugging` and `verification-before-completion` are now in `measure-a-change`, `read-agent-run` and `check`, adapted to our own tools.

Why few: studies of agent skills found that a skill helps on some tasks and models and not others, and that every skill makes the prompt longer ([arXiv 2610.04832](https://arxiv.org/html/2610.04832v1), [arXiv 2608.23067](https://arxiv.org/abs/2608.23067); abstracts and snippets only). Skills written from a project's own knowledge are kept over general ones.

Local only, not in git: `excalidraw-diagram` (its source has no licence) and `run-studio-campaign` (it names the home lab).
