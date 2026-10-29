# Plugins: the harness as code

Hooks run shell commands at fixed points. Plugins go further: a TypeScript or JavaScript file that runs **inside** Amness and can change nearly everything about how the agent behaves, and that `amness eval` can then measure against the built-in harness like any other variant.

A plugin can contribute:

| What | How | Use it for |
|---|---|---|
| **Loop rules** | `hooks`: a function per event (`SessionStart`, `UserPromptSubmit`, `PreModel`, `PostModel`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`) | block a tool call, rewrite its arguments, inject a note before the next model request, refuse to finish, log or measure anything |
| **Guardrails** | `PreToolUse` / `Stop` hooks, `failClosed: true` | house rules enforced in code; with `failClosed` a crash in your rule blocks instead of passing |
| **Tools** | `tools: [defineTool({...})]` | your own tools, with the same permission, approval, redaction and taint handling as built-in ones |
| **Prompt** | `system: (base) => ...` | rewrite or extend the system prompt |
| **Eval tasks** | `cases: [...]` with `check` as a function | graders written as code: parse output, run a script, inspect files, call an API |
| **Eval variants** | `variants: { name: { off, system, plugins, maxSteps, verify, build } }` | a harness configuration to compare; `build(model, opts)` can return a completely custom `Variant` |

## A minimal plugin

```ts
// .amness/plugins/no-lockfiles.ts
// definePlugin() only adds type checking; a plain exported object works the same, with no import.
import { definePlugin } from "<path to Amness>/src/index.ts";

export default definePlugin({
  name: "no-lockfiles",
  hooks: {
    PreToolUse: ({ tool, args }) =>
      (tool === "write_file" || tool === "edit_file") && /package-lock\.json$/.test(String((args as any).path))
        ? { block: "lockfiles are generated: run the package manager instead" }
        : undefined,
  },
});
```

A hook returns nothing (continue), a string (added as context), or `{ block, context, args }`. The first `block` stops the rest. A hook that throws only warns, unless the plugin sets `failClosed`. The payload carries the event name, the working directory and event data (for example `tool`, `args`, `result` for tool events; `step`, `budget`, `promptTokens` for `PreModel`; `text`, `tools`, `usage` for `PostModel`). A complete example with a tool, a prompt rewrite, an eval task and two variants is in [examples/plugins/house-rules.ts](../examples/plugins/house-rules.ts).

## Where plugins live, and trust

- `~/.amness/plugins/*.ts` always load.
- `.amness/plugins/*.ts` in a project load only after you approve **those exact files** (the chat asks; headless needs `--trust-project`). Changing a file asks again. A plugin runs with your full permissions: read it before you trust it.
- `/plugins` lists what is loaded. A broken plugin is a warning, never a crash.

## Evaluating your harness

```bash
amness eval --plugin examples/plugins/house-rules.ts --variants full,house-rules,lean --trials 3
amness eval --plugin my.ts --variants full,full+plugins     # every loaded plugin active in the `full` harness
amness eval --cases my-tasks.ts                             # a module exporting a list of cases (function graders allowed)
```

Variants named by a plugin are used by `name` or `plugin:name`. The usual statistics apply (paired comparison, cost per solved task), so "my loop against the default" is a measurement, not a feeling.

## What is not (yet) pluggable

The loop's own order (steer, budget, compact, model, tools, verify) and the permission engine are fixed; plugins act at the events around them. Replacing the loop outright (plan-execute, tree search), a custom compaction strategy, a custom router and slash commands from plugins are on the [roadmap](../ROADMAP.md) (Track C).
