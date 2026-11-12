---
name: read-agent-run
description: find out why an Amness run failed or behaved badly (an amness run --json log, a trace, a Harbor or Evaluation Studio trial) and whether the cause is the harness, the model, the task or the setup, before changing any code
---
Use this when a run failed, stopped early, looped, or used far more tokens than expected. Do not change a guard or a default because of one run: find the cause here, then measure with the `measure-a-change` skill.

## 1. Find the files

A Harbor or Evaluation Studio trial folder (`<jobs>/<job>/<task>__<id>/`) holds:

| File | What it says |
|---|---|
| `agent/amness.jsonl` | every event of `amness run --json`. First line: the config in effect. Last line: the result (`finished`, `stopped`, `steps`, tokens). |
| `agent/amness.trace.jsonl` | the loop trace (also usable with `amness replay`) |
| `agent/amness.stderr`, `agent/amness.exit` | errors, and the exit code (1 = not finished) |
| `verifier/test-stdout.txt` | the task's own tests: which passed and which failed, and why |
| `result.json` | Harbor's reward and timings |

For a local run, use the file you passed to `--trace`, or the `--json` output.

## 2. Read it in order

1. **The config line.** Did the run use what you think: `version`, `guardsOff`, `maxTime`, `thinkingBudget`, `toolChoice`, the profile sources? Many "failures" are a wrong setup.
2. **The result line.** `stopped` says why it ended: `time` (the time limit, set by `amness run`), or one of the values of `stopped` in the result type in `src/harness.ts` (on 2026-11-12: `stuck` for the stagnation or stuck guard, `budget`, `maxSteps`, `aborted`, `blocked` for a hook). No `stopped` and `finished: false` means the model ended with plain text and never called `finish`. `finished: false` with `stopped: time` is a limit, not a model error.
3. **The tests.** What exactly failed? "file not found" means the agent never produced the deliverable; a wrong value means it tried and got it wrong.
4. **The steps.** Print them:

   ```bash
   python3 .claude/skills/read-agent-run/steps.py <trial>/agent/amness.jsonl
   ```

   Look at seconds and tokens per step (a slow local model at about 60 s per step gets only about 13 steps in 13 minutes), repeated calls, the guard lines (`GUARD ...`), and the first edit (none at all is a strong signal).
5. **The harness checks.** In the Studio, each run shows the harness checks that fired; `node bin/studio.mjs checks <campaign>` lists them for a whole campaign.

## 3. Decide where the cause is

| What you see | Likely cause | Where to look |
|---|---|---|
| `stopped: stuck` after many turns with no edit, while the agent ran new shell commands | the stagnation guard may not count that work as progress: read what `observe` counts (before 0.8.1, shell reads and `diff`/`cmp` did not count; since then a shell read of a new file, a passing comparison and a check that passes after a new edit do) | `src/progress.ts` (`observe`) |
| the same call blocked again and again | the loop guard | `canonicalCall`, `findCycle` in `src/harness.ts` |
| `repair` lines, or calls refused as invalid JSON | malformed tool calls; is `argfix` on, does the model need `textToolCalls`? | `src/schema.ts`, `src/rescue.ts` |
| an edit refused as a placeholder | the hollow guard | `src/hollow.ts` |
| a finish refused, then accepted with notes | ledger, coverage or audit | `src/ledger.ts`, `src/coverage.ts` |
| the prompt size stops growing, then answers get worse | the server cut the prompt, or compaction | `src/context.ts`, the model's real window |
| `stopped: time` in the middle of a long thinking request | the time limit or the thinking budget | the campaign's `max_time`, `thinking_budget` |
| `finished: false`, no `stopped`, but the task passed | the model answered in plain text instead of calling `finish`, so the finish gate (ledger, coverage, audit, verify) never ran | the end of the loop in `src/harness.ts` |
| the agent re-reads or re-dumps the same files | the model; is earlier thinking kept (`keepThinking`)? | the model's profile |

Separate four kinds of cause: **harness** (a guard or tool did the wrong thing), **model** (wrong idea, repetition), **task** (needs more time or knowledge than the setup gives), **setup** (a limit or option you chose). Only a harness cause leads to a code change, and only after it is measured.

## 4. Report

Write a short report: the failure, the evidence (step numbers and lines), the cause and its kind, and the next check (usually one run with the suspected part switched off: `--ak off=<guard>` in a campaign, or `amness replay <trace> --off <guard>`). Say what one run can and cannot show.

Example (2026-11-12): cobol-modernization on a local Qwen failed twice. First `stopped: time` at 10 minutes (a setup cause: a 10-minute cap), then `stopped: stuck` after 12 turns of `od`, `xxd` and `cobc` with no edit (a possible harness cause in `src/progress.ts`). The check, one run with `off=stagnation`, also failed: stopped by time at step 13 with no edit. So the guard did not cost that pass. The cause was found by comparing a length-matched pair: a note at step 6 saying "write a first version now" made the agent write the program and pass, while a neutral note of the same length did not. That pointed at the harness after all (prompts made for editing an existing repository, shell reads not seen as reading), fixed in 0.8.1. Lesson: "the model" is a conclusion only after a harness-side change has been tried against a control.

The structure (capture, diagnose, contained next step, report) follows the agent-introspection-debugging skill of ECC (MIT, https://github.com/affaan-m/ECC), adapted to Amness's own logs.
