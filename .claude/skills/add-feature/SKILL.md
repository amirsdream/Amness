---
name: add-feature
description: add a tool, loop guard, slash command or provider, or do a ROADMAP item, with the tests, docs and roadmap tick this repo expects
---
Each item is one commit with code, tests, a doc update, and a README or ROADMAP line.

1. **Pick the place** (details in `docs/development.md`, "Add a feature"):
   - Tool: `src/code.ts`, `defineTool`, set `readOnly`, `risky` or `untrusted` correctly.
   - Guard: `src/harness.ts`; add to the `Guard` type and the `GUARDS` list in `src/profiles.ts`; `emit(...)` an event.
   - Slash command: `cli/tui/commands.ts`.
   - Provider: one function in a new file under `src/`, export from `src/index.ts`.
   - If only one user needs it, suggest a plugin (`docs/plugins.md`) instead.
2. **Test it** with a scripted model that makes the mistake. For a guard, add a case to `src/evalcases.ts`.
3. **Roadmap rule:** a Track B item does not become a default until `amness eval` shows it helps. If it is not measured, ship it off by default and say "not measured yet".
4. Run the `check` skill.
5. Update the docs page for the feature (follow the `write-docs` skill), tick the box in `ROADMAP.md`, add a line to the Done log, and add a `CHANGELOG.md` line if users will notice.
6. Commit with a short imperative subject. Do not push or tag unless asked.
