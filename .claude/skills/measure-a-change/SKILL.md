---
name: measure-a-change
description: decide whether a harness change (a guard, a default, a prompt, a profile setting) really helps, with amness eval or an Evaluation Studio campaign, before building on it or turning it on by default
---
Amness is in a "proof first" phase: a change is kept or made a default only when a measurement supports it. Use this before you change a guard or a default, and when a run shows a possible harness problem.

## 1. Write the claim first

One sentence, with what would prove it wrong. Example: "the stagnation guard stops runs that investigate through the shell; with `off=stagnation`, cobol-modernization writes program.py." Write it before the run, in the campaign's `purpose` or in the eval command's notes.

## 2. Pick the smallest setup that can answer it

| Question | Tool |
|---|---|
| Does a guard or variant change pass rate or tokens on small tasks? | `amness eval --variants full,full-<guard>` (built-in suites; see docs/evaluation.md) |
| Does a model qualify for a job? | `amness doctor <model>` or `amness eval --builtin ladder` |
| Does it hold on real terminal tasks? | an Evaluation Studio campaign (Terminal-Bench via Harbor; see `bench/harbor/README.md`) |
| Did one specific run fail because of the harness? | one run of that task with the suspected part switched off |

## 3. Size it honestly

- One run answers "did this cost a pass here", never "does this help in general".
- With 13 tasks only differences above about 55 points can be seen. `amness eval` prints this limit. Report the 95% interval, not just the pass rate.
- Trials of one task are linked: the task is the unit, and comparisons are paired by task.
- Report tokens per solved task, not per run. A variant that gives up early looks cheap per run.
- Keep a session short when the user asks (they asked for under 30 minutes per eval session): choose tasks and a session limit (`minutes`) that fit, and say what was left for the next session.

## 4. Keep the comparison fair

- Never choose or drop tasks because of their results. A subset made of tasks that pass is a smoke test, not a pass rate. Say so wherever its numbers appear.
- Change one thing per variant. Same build, model, server, thinking budget and time limit otherwise.
- Do not edit a campaign while it runs. When the setup must change, start a new campaign (or a new name) and keep the old results as they are. Every Studio row records its setup; check it before comparing.
- A longer prompt can help by itself. When a change adds prompt text (a skill, a note, a rule), compare with a control of the same length.
- Read the agent's config line (the first line of `amness run --json`) of one run to confirm the variant really ran: `version`, `guardsOff`, `maxTime`, `thinkingBudget`.

## 5. Decide and record

- `better` needs the whole interval above zero. Anything else is "not shown", not "equal".
- Write the result where the next session finds it (the notes for the topic), and a CHANGELOG line only when a default changes.
- If the change is kept, ship it as an option first; make it a default only after it holds on more tasks or a second model.

These rules follow the evaluation and harness-engineering skills of Agent-Skills-for-Context-Engineering (MIT, https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering), adapted to Amness.
