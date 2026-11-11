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

## Keeping skills true (no drift)

A skill that names something the code no longer has gives wrong instructions, and nobody notices. These rules prevent that.

1. **The test checks every name.** `test/skill-hygiene.test.ts` runs in CI. For our own skills it fails when a skill names a repo path, an npm script, an `amness` subcommand or flag, a guard, a function (written as "`fn` in `src/file.ts`" or "`src/file.ts` (`fn`)") or another skill that does not exist. Write such names in that form so the test can see them.
2. **Fix the skill in the same commit as the code.** When the test fails after a rename, update the skill, not the test.
3. **Point to the code; do not restate it.** Name the file and function and say what to read there. When a skill must state a behaviour or a number that can change (a threshold, a list of values, a known bug), date it: "on 2026-11-12, new shell output did not count". A dated fact is history; an undated one becomes a lie after the next fix.
4. **Never edit a copied skill.** Each copy records its upstream commit and the sha256 of its `SKILL.md` in `SOURCE.md`; the test fails if the file changes. To change one, write our own skill instead, or copy the newer upstream version and record its hash. Links inside a copy to skills we do not have (for example `context-degradation` in `context-compression`) are expected and ignored.
5. **One job per skill.** Before adding a skill, check that no skill here covers the job. Two skills that say the same thing drift apart.
6. **Local skills are checked too, on the machine that has them.** They are not in git, so CI never sees them; facts about machines in them (addresses, paths on a server) can only be checked by using them, so they say how to check first.
