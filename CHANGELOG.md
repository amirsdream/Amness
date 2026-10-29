# Changelog

## 0.1.0 (unreleased)

First public version. A terminal coding agent for OpenAI, Claude and local models, with a full-screen and an inline interface, headless mode, evals, memory, MCP and a library API.

- **Loop and guards:** claims ledger and audit of the finish summary, stagnation detection from test/build output, optional independent reviewer, loop and cycle detection, budget notes and a final report before the token cap, read-only streak check.
- **Safety:** permission rules with a floor that holds in yolo, OS sandbox (macOS Seatbelt, Linux bubblewrap), taint check for commands copied from untrusted text, secrets redaction, shell undo through git snapshots, optional approval reviewer.
- **Tools and context:** apply_patch and multi-edit, background processes, code index (`repo_map`, `find_refs`, `impact`), skills, custom subagents with worktree isolation, hooks, MCP, AGENTS.md loading, image input, optional language-server diagnostics.
- **Cost:** staged context trimming that keeps the provider cache valid, optional cache keep-alive, model routing, per-role models, subagent budget slices.
- **Workflow:** git worktree sessions, `/review`, `/pr`, `/branch`, `amness schedule`, `amness acp`, a GitHub Action.
- **Measurement:** `amness eval` (paired statistics, ablations, SWE-bench-format suites, leak audit), `amness tune`, trace replay, failure mining.

Known limits: newer features are tested with scripted models but not yet measured on real tasks; Windows has no OS sandbox. See ROADMAP.md.
