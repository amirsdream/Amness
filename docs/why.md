# Why: what Amness checks so you do not have to

Most agent failures are not "the model is dumb"; they are mechanical: malformed tool calls, "I'll now do X" with no action, claiming success without checking, repeating the same call, editing a file it never read, or a context window that quietly fills up. Amness puts a mechanical check on each of those, then wraps it in a comfortable terminal UI:

| Problem | What Amness does |
|---|---|
| Bad tool arguments | Validates against the schema and feeds the exact error back so the model repairs its own call |
| Stops early or only narrates | Nudges it to act; plain answers are still accepted |
| "Done!" without proof | A `verify` command (for example `npm test`) must actually pass before it may finish |
| Edits files it never read | Read-before-edit is enforced; edits need a unique match |
| Dangerous commands | `rm -rf`, `git push`, installs, `curl \| sh` and similar need a human; a hard floor (no `rm -rf /`, no editing `.git`, no force-push to main) holds even in `yolo`, and your own allow/ask/deny rules sit on top |
| Context fills silently | Live context gauge, a map of what fills it, automatic handoff to a fresh context |
| Reasoning lost between tool calls | Reasoning items are replayed with tool results (OpenAI Responses, Claude thinking blocks) |
| Stuck in a failing loop | Reflection prompt after 3 all-failing turns, a clean stop after 6, a wrap-up warning before the step cap |
| Noisy, stale tool output eating the window | Output condensed on arrival; repeated and expired reads dropped; old output elided in one cut |
| Paying full price for the same prefix | Append-only history, stable tool order, cache-break detection, optional Claude keep-alive |
| Memory that grows noisy | Ranked retrieval, duplicate merging, learning from run outcomes, reversible forgetting |
| "Does this guard actually help?" | `amness eval`: paired, task-level statistics with cost per solved task |
