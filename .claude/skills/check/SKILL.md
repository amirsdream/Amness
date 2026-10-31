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
