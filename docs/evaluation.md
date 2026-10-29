# Evaluating the harness

Every guard and efficiency feature can be switched off, so "does this help?" is a measurement, not an opinion:

```bash
amness eval --selftest                       # prove every task is solvable and its held-out check is sound (no model, free)
amness eval --variants ab --trials 3         # baseline (no guards) vs full harness on 13 built-in tasks
amness eval --variants ablate --trials 5     # full harness, then each guard removed in turn
amness eval --cases ./my-tasks --jobs 3      # your own tasks: a folder of *.json
amness eval --report .amness/evals/<run>.json   # re-analyse saved results, runs nothing
```

Each task runs in a fresh temporary workspace. The agent sees the task and an optional `verify` command; a **held-out `check`** it never sees decides pass or fail. Variants: `baseline`, `full`, `full+check`, `no-gate`, and `full-<guard>` for each of `nudge loop compact stuck wrapup condense schedule ledger stagnation index`.

What the report gives you, and why:

- **Tasks are the unit of analysis.** Repeated trials of one task are correlated, so intervals are 95% bootstrap intervals over tasks, and comparisons are paired by task.
- **A paired comparison against the baseline:** change in pass rate with its interval, wins/losses/ties, an exact sign test (McNemar's exact test on the tasks where two variants differ) with Holm correction across variants, and a verdict of `better`, `worse` or `inconclusive`.
- **Reliability, not just a pass rate:** `pass^k` is the chance that k attempts at a task *all* pass, which exposes variants that only succeed sometimes.
- **Cost per solved task, not per run:** a variant that is cheap because it gives up is not efficient. A `●` marks variants on the pass-rate versus tokens-per-solve Pareto frontier.
- **Why a variant behaves as it does:** how often each guard fired per run (nudges, loop blocks, rejected finishes, trimmed output).
- **An honest power note.** With 12 tasks only large differences (about 60 points) are detectable; the report says so instead of declaring a winner. Add tasks with `--cases` before trusting a small difference.

**Public benchmarks (SWE-bench format).** `amness eval --suite instances.jsonl --test-cmd "python -m pytest -x -q {tests}" --install "pip install -e ." --limit 20` loads instances in SWE-bench's field names, clones each repository at its base commit, lets the agent work, and only then applies the hidden tests from a file outside the workspace and runs the instance's FAIL_TO_PASS ids. An instance that cannot be prepared (missing commit, failed install) is **excluded and listed in an exclusion ledger** in the report, never silently counted as a failure. `--audit` checks the suite for contamination without calling a model (fix lines present in the problem statement, or already in the base checkout, or a missing base commit), `--trials` gives independent seeds and `--seed` makes the bootstrap intervals reproducible. Most public benchmarks need per-instance environments (usually Docker images) that you must provide through `--install` or a prepared image; Amness supplies the harness and the statistics, and has not been run against a full public benchmark yet.

The method follows recent evaluation practice: harness choice can change cost per solved task by large factors while pass-rate differences stay small ([The Scaffold Effect in Coding Agents](https://arxiv.org/abs/2607.22585)), and task-level paired bootstrap intervals are the right uncertainty statement ([Harness or Model?](https://arxiv.org/html/2609.11987v1)). The built-in suite is small and synthetic; it is a regression harness for the guards, not a substitute for SWE-bench-style benchmarks, and a real run costs real tokens (the command asks before starting).

## Measured results so far

Real runs, one model (`gpt-6-luna` through the OpenAI API), 2026-10-29. These are small and say little about harder tasks or other models.

| Run | Result |
|---|---|
| 13 built-in tasks × 2 trials: `baseline`, `full`, `full+review` | Pass rates 96%, 100%, 100%. Tokens per solved task: 9.2k, 8.3k, 14.7k. No pairwise difference is statistically detectable (13 tasks can only detect differences above ~55 points). `full` was cheaper than `baseline` (-971 tokens per solved task) with the same pass rate; `full+review` cost about 77% more tokens per solved task than `full` and about 2.4× the time, with no gain on these tasks. |
| Adversarial suite (3 prompt-injection tasks × 3 trials): `full`, `full-taint`, `baseline` | 100% for all three: this model did not follow the injected commands even without the taint check, so the check had nothing to catch. It remains untested whether it helps with models that are more easily led. |

What this means: the built-in tasks are too easy for this model to separate the variants, and the reviewer is not worth its cost on them. The `full+route`, ablation, `tune` and best-of-n features are not measured. Harder tasks (for example a SWE-bench-format suite with `--suite`) are needed before any guard can be shown to help or hurt. Raw results were saved under `.amness/evals/` (not committed).

### Second round (2026-10-30): a harder suite and weaker models

`amness eval --builtin hard` has 6 tasks with hidden edge cases, a misleading symptom, a question to answer from a 50-file repository, a string-dispatch rename, an async-ordering bug and a slow function. All six have a reference solution checked by `--selftest`.

| Run | Result |
|---|---|
| `gpt-6-luna`, hard suite × 3 trials: `baseline`, `full`, `full+review` | 100% for all three. Tokens per solved task 9.7k / 11.7k / 20.5k: on a model this strong the guards cost 20% more tokens and the reviewer more than double, for no gain. |
| `gpt-4.1-mini`, hard suite × 3 trials, same three variants | 89% / 83% / 89%; the one task all variants miss (`spec-in-docs`: hidden edge cases listed only in a spec file) is missed by every variant, including the reviewer. Tokens per solved task 15.2k / 14.7k / 26.3k. No difference is detectable (6 tasks). |
| `gpt-4.1-mini`, hard suite × 2 trials, `full` against each `full-<guard>` (144 sessions) | Every comparison is inconclusive (pass-rate changes between -17 and +8 points, intervals include zero); removing `taint`, `condense`, `ledger` or `stagnation` was not worse and used fewer tokens, but 6 tasks × 2 trials cannot support removing anything. |
| Injection suite, `gpt-4o-mini`, 6 trials: `full`, `full-taint`, `baseline` | 100% for all: the model did not follow the injected commands even without the taint check. |
| Budget fix, `gpt-4.1-mini`, exploration question, cap 2,500 tokens, 8 runs | Without the final report 7 of 8 runs ended with a bare "token budget exhausted" and nothing else; with it all 8 ended with a short report of what was found and what was left (it named the right file in most), but none completed the answer (the cap was smaller than one full exploration). At caps where the task fits (6,000) both behave the same (8 of 8 answered). At 4,000, 7 of 8 answered without the report and 6 of 8 with it: wrapping up early costs a little completion when the cap is very tight (small sample). |

What this says: the guards neither help nor hurt measurably on these tasks and models; the cost overhead is real and shows even on strong models; the injection suite is too easy; and `spec-in-docs` shows a gap worth fixing (neither the reviewer nor any guard makes the model re-read the spec). `gpt-4.1-nano` and `gpt-3.5-turbo` returned HTTP 404 on this account, so they were not tested.
