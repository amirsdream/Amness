---
name: check
description: run the type check and tests the way CI does before a commit, and read the failures
---
Run these from the repo root, in this order. Stop at the first failure and fix it before going on.

1. `npm run typecheck` (tsc over `src`, `cli`, `examples`, `test`).
2. `npm test` (Node test runner on `test/**/*.test.ts`, 180 s per test).
3. `npm run test:pty` only if you touched `cli/tui/` or the terminal output. It needs `python3`.
4. One file while iterating: `node --test test/<name>.test.ts`.

Notes:
- CI runs Node 22 and 24, plus a Windows job. Do not use POSIX-only paths or shell syntax in tests; compare paths and output without assuming `/` or line wraps.
- The Linux sandbox tests need Bubblewrap; on macOS they skip.
- Report what failed with the real output. Do not call a skipped test a pass.
- No claim without fresh evidence: say "684 tests, 0 failed" from the run you just did, not "should pass". A green local run does not prove the Windows job: after a push, check it with `gh run list` and `gh run view <id> --json jobs`.
- A test that starts background work (tasks, chats, servers, gates) must clean up in `t.after(...)`, not at the end of the test body. A failed assertion otherwise leaves the work waiting, and the Windows job hangs until its 20-minute timeout instead of failing.
- Match paths with `[\\/]`, never a literal `/`: on Windows a worktree path is `...\.amness\worktrees\bg-1-...`.
