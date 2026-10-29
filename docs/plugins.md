# Plugins: the harness as code

A plugin is a TypeScript or JavaScript file that runs inside Amness and can change how the agent behaves, and `amness eval` can measure it against the built-in harness.

In this page you will learn:

- what a plugin can add, and where plugin files live
- how to write, load and test your first plugin
- the eight hook events and what each one receives
- how to write eval tasks and variants as code
- what a plugin can do to your machine

## What a plugin is

Hooks in a config file run shell commands at fixed points. A plugin goes further. It is code that Amness loads into its own process. A plugin can contribute:

| What | How | Use it for |
|---|---|---|
| **Loop rules** | `hooks`: one function per event | Block a tool call, rewrite its arguments, add a note before the next model request, refuse to finish, log anything. |
| **Guardrails** | `PreToolUse` and `Stop` hooks, with `failClosed: true` | House rules in code. With `failClosed`, a crash in your rule blocks the action instead of letting it pass. |
| **Tools** | `tools: [defineTool({...})]` | Your own tools for the agent. |
| **Prompt** | `system: (base, ctx) => ...` | Extend or rewrite the system prompt. |
| **Eval tasks** | `cases: [...]` | Tasks whose check is a function. |
| **Eval variants** | `variants: { name: {...} }` | A harness setup to compare with others. |

The tested code is in `src/plugins.ts` and `test/plugins.test.ts`. A full example with a tool, a prompt rewrite, an eval task and two variants is in [examples/plugins/house-rules.ts](../examples/plugins/house-rules.ts).

## Write your first plugin

This plugin stops the agent from editing lockfiles by hand.

1. Create the folder and the file in your project:

   ```bash
   mkdir -p .amness/plugins
   ```

2. Save this as `.amness/plugins/no-lockfiles.ts`:

   ```ts
   export default {
     name: "no-lockfiles",
     description: "never hand-edit package-lock.json",
     hooks: {
       PreToolUse: ({ tool, args }: { tool: string; args: any }) =>
         (tool === "write_file" || tool === "edit_file") && /package-lock\.json$/.test(String(args.path))
           ? { block: "lockfiles are generated: run the package manager instead" }
           : undefined,
     },
   };
   ```

   A plain exported object works. If you want type checking, import `definePlugin` from `src/index.ts` of Amness and wrap the object. `definePlugin` only returns the object you give it.

3. Start Amness in the project folder:

   ```bash
   amness
   ```

   Amness asks if you trust the plugin files in `.amness/plugins`. Choose "Yes, trust this version". Amness remembers this for these exact files. If you change a file, it asks again.

4. See the plugin:

   ```text
   /plugins
   ```

   You will see a line with the name `no-lockfiles`, `hooks: PreToolUse` and your description.

5. Trigger it. Ask the agent to make a change that needs a lockfile edit:

   ```text
   Edit package-lock.json by hand and change the version of the root package to 9.9.9.
   ```

6. When the agent tries `write_file` or `edit_file` on that path, the hook blocks the call. The agent gets this text as the tool result:

   ```text
   BLOCKED BY A HOOK: lockfiles are generated: run the package manager instead
   Do not retry the same call; choose another approach or explain what you could not do.
   ```

   The chat marks the call as denied. The words the agent then writes will differ from run to run.

If the file has a mistake, Amness shows a warning such as `plugin: <file>: could not load: ...` and starts anyway.

### Hook return values

A hook may return:

- nothing (`undefined`): continue
- a string: added as context for the agent
- an object `{ block, context, args }`: stop the action with a message, add context, or replace the tool arguments

The first `block` stops all later hooks. If several hooks return `context`, Amness joins them. The last `args` win. Plugin hooks run after your shell hooks. A hook may be `async`.

A hook that throws only gives a warning. If the plugin sets `failClosed: true`, a throw blocks instead.

## The eight hook events

Every payload also has `event` (the event name) and `cwd` (the working folder). The table lists the other fields. They are taken from `src/harness.ts` and `src/code.ts`.

| Event | When it runs | Extra payload fields | What a return value does |
|---|---|---|---|
| `SessionStart` | With the first message of a conversation | none | `context` is added to the message. `block` refuses the message. |
| `UserPromptSubmit` | Each time you send a message | `prompt` | `context` is added to the message. `block` refuses the message. |
| `PreModel` | Before every model request | `step`, `max`, `messages`, `promptTokens`, `budget` | A string or `context` is added as a user note. `block` ends the run with `stopped: <message>`. |
| `PostModel` | After every model reply | `step`, `text` (first 4000 characters), `tools` (names of the tools the model called), `usage` | Ignored. Use it to log or measure. |
| `PreToolUse` | Before a tool runs | `tool`, `args` | `block` stops the call. `args` replaces the arguments (they must still match the tool schema). `context` is not read for this event in the harness. |
| `PostToolUse` | After a tool runs | `tool`, `args`, `result` (clipped to 4000 characters), `ok` | `context` is added to the end of the result. `block` is not used. |
| `PreCompact` | Before old tool output is trimmed | `chars` (size of the history) | `block` cancels the trim for this step. |
| `Stop` | When the agent calls `finish` | `summary` | `block` rejects the finish. The agent sees `REJECTED by a hook: <message>` and must continue. |

Notes:

- `budget` in `PreModel` is the share of the token cap used so far, from 0 to 1.
- `ok` in `PostToolUse` is false when the result starts with `ERROR` or `DENIED`.
- `step` starts at 0.
- `SessionStart` and `UserPromptSubmit` run in the code agent (`src/code.ts`). The other six run in the loop (`src/harness.ts`).

The example plugin uses three of these events:

- `PreToolUse` blocks lockfile edits.
- `Stop` makes the agent say which command it ran before it finishes.
- `PreModel` reminds the agent at step 10 if it has used less than half of its budget and is still reading.

## Add a tool or change the prompt

A tool uses `defineTool`:

```ts
import { definePlugin, defineTool } from "<path to Amness>/src/index.ts";

export default definePlugin({
  name: "changelog",
  tools: [defineTool({
    name: "changelog_hint",
    description: "Returns the repository's changelog convention.",
    readOnly: true,
    schema: { type: "object" },
    run: () => "Add one line under 'Unreleased' in CHANGELOG.md.",
  })],
  system: (base) => base + "\nMention any file you could not verify.",
});
```

`system` runs once when a conversation starts. Plugins apply in load order. Set `readOnly: true` only for tools that change nothing.

## Write eval cases and variants

A plugin can bring its own eval tasks and harness variants, so you can test a rule before you trust it. For how to read the results, see [Evaluating the harness](evaluation.md).

### A case with a function grader

```ts
cases: [{
  name: "lockfile-trap",
  files: { "package-lock.json": "{}\n", "package.json": '{"name":"x"}\n', "a.txt": "one\n" },
  task: "Change the text in a.txt from 'one' to 'two'. Do not touch anything else.",
  check: async (dir: string) => {
    const fs = await import("node:fs");
    return fs.readFileSync(`${dir}/a.txt`, "utf8").trim() === "two"
        && fs.readFileSync(`${dir}/package-lock.json`, "utf8") === "{}\n"
      ? true
      : "wrong a.txt or lockfile changed";
  },
  solution: { "a.txt": "two\n" },
}],
```

- `check` gets the workspace folder. It returns `true` to pass, or text that explains the failure. It can also be a shell command string.
- `solution` is a known good fix. Without it, `--selftest` only checks that the check fails at the start.
- A case may also have `verify` (a command the agent may run), `tools` (extra tools for this case) and `setup` (prepare the folder; if it fails, the case is excluded instead of counted as a failure).

### A variant

```ts
variants: {
  "house-rules": { off: [], verify: true },
  "lean": { off: ["nudge", "condense", "wrapup"], verify: true, system: (b) => b + "\nBe brief." },
},
```

| Field | Meaning |
|---|---|
| `off` | Guards to switch off. The names are `nudge`, `loop`, `compact`, `stuck`, `wrapup`, `condense`, `schedule`, `ledger` and `stagnation`. |
| `maxSteps` | Step limit for this variant. |
| `verify` | `false` removes the case's verify command as the finish gate. The default is on. |
| `review` | `true` adds the independent reviewer. |
| `plugins` | Names of other loaded plugins that are active in this variant. The plugin that defines the variant is always active. |
| `system` | Rewrites the system prompt for this variant. |
| `build` | `build(model, { maxSteps, maxTokens })` returns a complete custom `Variant`. When set, the other fields are not used. |

### Run it

1. Check that your cases are sound. This calls no model.

   ```bash
   amness eval --plugin examples/plugins/house-rules.ts --selftest
   ```

   You will see the built-in tasks and then `ok  lockfile-trap`.

2. Compare variants. This calls your model and asks before it starts.

   ```bash
   amness eval --plugin examples/plugins/house-rules.ts --variants full,house-rules,lean --trials 3
   ```

3. Put all loaded plugins into the `full` harness:

   ```bash
   amness eval --plugin my.ts --variants full,full+plugins
   ```

4. Use a module of cases with function graders, without a plugin:

   ```bash
   amness eval --cases my-tasks.ts
   ```

Use a variant by `name` or by `plugin:name`, for example `house-rules:lean`. `--plugin` takes a comma-separated list of files. Passing a file with `--plugin` counts as your approval of that file.

## Safety: what a plugin can do

- **A plugin has your full permissions.** It is ordinary code in the Amness process. It can read files, run commands and use the network. Read a plugin before you trust it.
- **User plugins** in `~/.amness/plugins/` always load. Put only files there that you wrote or read.
- **Project plugins** in `.amness/plugins/` load only after you approve those exact files. Amness stores a fingerprint of the files. Any change to a file asks again. This protects you from a cloned repository that brings its own plugin.
- **Headless runs** do not load project plugins unless you pass `--trust-project`. Without it, Amness prints a note that tells you how many files it skipped.
- **A broken plugin is a warning**, never a crash. Two plugins with the same name: the second is skipped with a warning.
- **A hook that throws** only warns, unless the plugin sets `failClosed: true`. Use `failClosed` for rules that must always hold.
- **Names** may use letters, numbers, `.`, `_` and `-`, up to 40 characters.
- **Plugin tools** are added to the same tool list as built-in tools, so the harness handles their calls like other tool calls. Set `risky` on a tool that changes things. Not verified: how each permission mode treats every plugin tool.
- **Do not rely on the sandbox to limit plugin code.** The sandbox setting is for agent commands. Whether it limits plugin code is not verified.

## Limits and common problems

- The loop order (steer, budget, compact, model, tools, verify) and the permission engine are fixed. Plugins act at the events around them.
- Replacing the loop, a custom compaction strategy, a custom router, and slash commands from plugins are planned in the [roadmap](../ROADMAP.md) (Track C). They do not exist yet. There is also no hot reload yet, so restart Amness after you change a plugin file.
- `PostModel` cannot change anything. `PostToolUse` cannot block.
- The approval question appears in the chat. In headless mode, use `--trust-project`.
- No plugin has been measured to improve results. The `house-rules` example was run once against a real model, and it is not a benchmark.
- If your plugin does not show in `/plugins`, check the warning lines at the top of the chat. Common causes: no `name`, a name with spaces, `hooks` that is not a map of functions, or a syntax error.

## Related pages

- [Evaluating the harness](evaluation.md): how to measure a plugin.
- [Features in depth](features.md): shell hooks, permissions and the safety floor.
- [Use it as a library](library.md): `createCodeAgent` and `createHarness`.
- [Safety and privacy](safety.md)

## Next steps

- Copy [examples/plugins/house-rules.ts](../examples/plugins/house-rules.ts) to `.amness/plugins/` and change it.
- Measure your rule with `amness eval`, as shown in the [Cookbook](cookbook.md).
- Read the [roadmap](../ROADMAP.md) for what plugins cannot do yet.
