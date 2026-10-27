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
