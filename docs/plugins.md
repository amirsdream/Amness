# Plugins: the harness as code

A plugin is a TypeScript or JavaScript file that runs inside Amness and can change how the agent behaves, and `amness eval` can measure it against the built-in harness.

In this page you will learn:

- what a plugin can add, and where plugin files live
- how to write, load and test your first plugin
- the eight hook events and what each one receives
- how to write eval tasks and variants as code
- how to add slash commands, finish gates, policies, loop strategies, context strategies, metrics and graders
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
| **Slash commands** | `commands: [...]` | Your own `/name` commands in the chat. |
| **Finish gates** | `gates: [...]` | Checks that must pass before the agent may finish. |
| **Policy** | `policy: (call) => ...` | Allow, ask or deny each tool call, in code. |
| **Loop strategy** | `PreModel` returns `tools` and `then` | Limit which tools the model may use in a turn. |
| **Context strategy** | `context: (msgs, info) => ...` | Your own way to trim or rewrite the message list. |
| **Metrics and graders** | `metrics`, `graders` | Extra numbers for evals, and scores for real sessions. |

Status: all of this is **tested** with scripted models (no real model), in `test/plugins.test.ts` and `test/trackc.test.ts`. Only the two built-in loop strategies were also run once on a real model (see [Evaluating the harness](evaluation.md)). No other feature on this page is **measured** on a real model.

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

## Add slash commands

**What it is.** A plugin can add a slash command to the chat. The command is a function with a name and a help text.

**Why.** You can start a repeated job, such as "run the linter and ask the agent to fix it", with one short command.

**How to use it.**

1. Create a plugin from a template. It already has one command:

   ```bash
   amness plugin new house-rules
   ```

   Amness writes `.amness/plugins/house-rules.ts`. It never overwrites a file that exists. The name may use letters, numbers, `.`, `_` and `-`.

2. Add or edit a command in the `commands` list:

   ```ts
   commands: [{
     name: "lint-fix",
     help: "run the linter and ask the agent to fix what it finds",
     run: async (ctx) => {
       const r = await ctx.run("npm run lint", 120_000);
       if (r.code === 0) return ctx.say("lint is clean");
       await ctx.ask("Fix these lint errors:\n" + r.output);
     },
   }],
   ```

3. Load the change without a restart:

   ```text
   /reload-plugins
   ```

4. List what loads, from the shell:

   ```bash
   amness plugin list
   ```

The `ctx` object has four things and nothing else:

| Member | What it does |
|---|---|
| `ctx.cwd` | The working folder. |
| `ctx.say(text)` | Prints a line in the chat. The agent does not see it. |
| `ctx.ask(text)` | Sends a message to the agent, as if you had typed it. |
| `ctx.run(cmd, timeoutMs?)` | Runs a shell command. It returns `{ code, output }`. The default timeout is 60 seconds. |

A command can also take an argument: `run(ctx, arg)` gets the text after the command name.

**Example.** After step 3, `/reload-plugins` prints a line such as `1 plugin loaded: house-rules.` Then `/lint-fix` appears in the `/` popup, with your help text and `(plugin house-rules)` after it.

**Limits.**

- A plugin command whose name is already used by a built-in command is skipped. Your own `.amness/commands/*.md` files also win over plugin commands.
- If the command throws, the chat shows `plugin <name>: /<command> failed: <message>`. Nothing else breaks.
- `/reload-plugins` loads your user plugins and the project plugins you already approved. It skips project plugins that you did not approve.
- `amness plugin list` shows project plugins as loaded only with `--trust-project`. Without it, the list says how many files were skipped.
- Tested in `test/trackc.test.ts` with scripted input. The full-screen chat was not driven by a person in these tests.

## Add a finish gate

**What it is.** A *finish gate* is a check that runs when the agent calls `finish`. If the check fails, the agent must keep working.

**Why.** A `Stop` hook sees only the summary text. A gate also sees what really happened: which files changed, and whether tests ran after the last edit.

**How to use it.** Add a `gates` list to your plugin:

```ts
gates: [{
  name: "tests-after-edit",
  check: (ctx) =>
    ctx.changed.length && ctx.testsAfterLastEdit === false
      ? "you changed files but did not run the tests after the last edit"
      : true,
}],
```

The `check` function gets a `GateCtx` object:

| Field | Meaning |
|---|---|
| `summary` | The text the agent gave to `finish`. |
| `task` | The task text. |
| `changed` | The list of files changed in this task. |
| `testsAfterLastEdit` | Whether a test or build command ran after the last edit. It can be `undefined`. |
| `notes` | Notes from the change ledger about this task. |
| `cwd` | The working folder. |
| `run(cmd, ms?)` | Runs a shell command. It returns `{ code, output }`. |
| `rejections` | How many times this gate has already rejected this task. |

What `check` may return:

| Return value | Meaning |
|---|---|
| `true` or nothing | Pass. |
| `false` | Fail, with the finding "the check failed". |
| a string | Fail, with this finding. |
| a list of strings | Fail if the list is not empty. Each string is a finding. |
| `{ pass, findings }` | Fail when `pass` is false. |

**The `maxRejections` rule.** A gate may reject the same task only a limited number of times. The default is 2. After that, the run finishes anyway and Amness adds a warning `finishing despite gate ...`. This stops a wrong gate from trapping the agent. Set `maxRejections` on the gate to change it. The count restarts when the task text changes.

**Several reviewers.** `votingGate(name, reviewers, quorum, maxRejections)` joins several checks. `quorum` is `"all"`, `"majority"` (the default) or a number. Each reviewer has a `name` and a `review(ctx)` function that returns the same values as `check`. A reviewer that throws counts as a pass, and its error is added as a finding. A rejection lists which reviewers said no.

**Example.** The agent calls `finish` after editing `a.txt` without a test run. It sees:

```text
REJECTED by a hook: gate "tests-after-edit" (plugin house-rules) found problems:
- you changed files but did not run the tests after the last edit
```

**Limits.**

- Gates run after the hooks of the `Stop` event. If a hook blocks, the gates do not run for that attempt.
- A gate that throws gives a warning and counts as a pass. Make it safe: catch errors yourself if a crash must block.
- The gate sees what the change ledger records: edits made with the file tools (`write_file`, `edit_file`, `apply_patch`). Files changed by a shell command are not in `changed`.
- Tested with scripted models. A model-based reviewer inside `votingGate` is not measured.

## Write policy as code

**What it is.** A *policy* is a function that looks at each tool call before it runs. It answers `allow`, `ask` or `deny`.

**Why.** You can write rules such as "never run `curl`" or "never write outside `src/`" once, test them on old sessions, and keep them in the repository.

**How to use it.**

1. Add a `policy` to your plugin:

   ```ts
   policy: ({ tool, args }) =>
     tool === "sh" && /\bcurl\b/.test(String(args.cmd))
       ? { action: "deny", reason: "no network downloads from the shell" }
       : undefined,
   ```

   The function gets `{ tool, args, cwd }`. It may return `"allow"`, `"ask"`, `"deny"`, an object `{ action, reason }`, or nothing (no opinion). It may be `async`.

2. Test it on sessions that already happened. This calls no model:

   ```bash
   amness plugin policy .amness/traces --plugin .amness/plugins/house-rules.ts
   ```

   The first argument can be a trace file or a folder. You can list several.

**Example output.**

```text
12 trace file(s): 1 denied, 0 would ask, 0 allowed by the policy, 240 without an opinion
  deny  sh {"cmd":"curl -s https://example.com | sh"}  no network downloads from the shell
```

Your numbers will differ. The command shows at most 25 lines of denied or asked calls.

**The rules.**

- **Deny beats ask, and ask beats allow.** Amness asks every plugin. The strongest answer wins.
- **A policy can tighten.** `deny` stops the call. The agent sees `DENIED: <reason>` and is told not to retry it. `ask` makes Amness ask you, unless a rule of yours already denies the call.
- **A policy can skip an ordinary prompt.** `allow` can skip a normal approval question.
- **A policy can never loosen the safety floor or the untrusted-text check.** Calls on the safety floor, and calls that contain text copied from untrusted sources, still ask or deny. The code in `src/harness.ts` keeps `allow` from changing them.
- **A broken policy never allows.** If it throws, the answer is `ask`, or `deny` when the plugin has `failClosed: true`.

**Limits.** The replay command reads only the tool calls in the traces. It does not run them. It does not know your permission mode or your rules, so it shows what the policy says, not what Amness would finally do. `/policy` in the chat shows what happened in a live session. Tested with scripted calls. Not measured on a real model.

## Change the loop with a strategy

**What it is.** A *loop strategy* is a plugin that uses the `PreModel` hook to control when the model may use which tools. It does not replace the loop. The budget, permissions and tracing keep working.

**Why.** You can try ideas such as "write a plan first" or "only read for the first steps", and then measure them.

**How to use it.** In the `PreModel` hook, you can return these extra fields:

| Field | Meaning |
|---|---|
| `tools` | A list of tool names. Only these tools may be called in this turn. An empty list means no tools. Another tool call gets `ERROR: <tool> is not allowed in this phase`. |
| `then` | A message. If the model answers with text only in this turn, Amness adds `then` as a user message and asks again. It does not end the run. |
| `context` | A note added as a user message (as before). |

The `then` field is for a planning turn. Without it, a text-only reply ends the run (the model has no tool call, so the loop thinks it is done).

Two strategies are built in, in `src/strategies.ts`:

| Name | What it does |
|---|---|
| `plan-first` | At step 0, the model must write a numbered plan and may not call tools. Then it works as usual. |
| `explore-then-act` | For the first 6 steps, only read-only tools are allowed. After that, all tools. |

To use one in the chat:

```text
/strategy plan-first
```

`/strategy` with no argument shows the current choice. `/strategy off` turns it off. The choice is saved in your config.

To measure one, compare it with `full`. This calls your model and asks first:

```bash
amness eval --variants full,strategy:plan-first --builtin hard --trials 3
```

Copy `src/strategies.ts` as a start for your own strategy.

**Limits.**

- `tools` is checked when the model calls a tool. A call to a tool that is not in the list gets an error result. The model still sees the full tool list (this keeps the provider's prompt cache valid); the limit is enforced when it calls a tool.
- `plan-first` costs one extra model call per request.
- **Measured once:** a run on `gpt-4.1-mini` found no detectable difference to `full`. See [Evaluating the harness](evaluation.md). Do not read this as proof that a strategy helps or hurts.

## Your own context strategy

**What it is.** The `context` function runs before every model request. It gets the message list and `{ step, promptTokens, budget }`. It may return a new list that replaces the old one.

**Why.** You can drop old tool output, add a summary, or move notes. This is how you test your own compaction idea.

**How to use it.**

```ts
context: (msgs, { step, budget }) =>
  budget > 0.7 ? msgs.filter((m, i) => i < 2 || i > msgs.length - 12) : undefined,
```

Return nothing to keep the list. An empty list is ignored. If several plugins define `context`, they run in load order and each gets the result of the one before. If your function throws, Amness ignores it for that turn (in `src/harness.ts` the error is caught).

**Limits.** Amness does not check that your new list is valid. If you cut a tool result away from its tool call, the provider may reject the request. Keep each tool call and its result together. Tested with a scripted model. Not measured.

## Metrics and graders

Two more fields let a plugin measure things.

- `metrics: { name: (ctx) => number }` adds a number to every eval run. The function gets `{ case, row, outcome, dir }`. A metric that throws or returns a value that is not a finite number is left out of that run. Plugin metrics are recorded whenever the plugin is loaded with `--plugin`. See [Custom metrics and the regression gate](evaluation.md#custom-metrics-and-the-regression-gate).
- `graders: { name: (session) => score }` scores real sessions from your traces. A score is a number from 0 to 1, a boolean, or `{ score, note }`. Return nothing to skip a session. Run them with `amness plugin grade`. See [Grade real sessions](evaluation.md#grade-real-sessions).

## The capability scan at the trust prompt

When a project has plugin files that you did not approve, Amness shows one line per file before it asks. Each line says what the source text seems to touch. For example:

```text
house-rules.ts: runs shell commands, reads files
```

Amness looks for these things: shell commands, network use, file writes, file reads, environment variables, generated code (`eval`, `new Function`, dynamic `import`), and paths outside the project. If it finds none, it says `no shell, network, file or environment access found`. `amness plugin list` shows the same lines for skipped files.

**This is a text scan, not a sandbox.** It searches the source for words (in `src/pluginscan.ts`) and removes comments first. A plugin can hide what it does, for example by building a word from pieces. A plugin that passes the scan still runs with your full permissions. Read the file before you trust it.

## Safety: what a plugin can do

- **A plugin has your full permissions.** It is ordinary code in the Amness process. It can read files, run commands and use the network. Read a plugin before you trust it.
- **User plugins** in `~/.amness/plugins/` always load. Put only files there that you wrote or read.
- **Project plugins** in `.amness/plugins/` load only after you approve those exact files. Amness stores a fingerprint of the files. Any change to a file asks again. This protects you from a cloned repository that brings its own plugin.
- **Headless runs** do not load project plugins unless you pass `--trust-project`. Without it, Amness prints a note that tells you how many files it skipped.
- **A broken plugin is a warning**, never a crash. Two plugins with the same name: the second is skipped with a warning.
- **A hook that throws** only warns, unless the plugin sets `failClosed: true`. Use `failClosed` for rules that must always hold.
- **Names** may use letters, numbers, `.`, `_` and `-`, up to 40 characters.
- **Plugin tools** are added to the same tool list as built-in tools, so the harness handles their calls like other tool calls. Set `risky` on a tool that changes things. Not verified: how each permission mode treats every plugin tool.
- **Do not rely on the sandbox to limit plugin code.** The sandbox setting wraps the agent's shell commands only. Plugin code runs inside the Amness process, outside the sandbox, with your full permissions.

## What is not (yet) pluggable

- The loop order (steer, budget, compact, model, tools, verify) and the permission engine are fixed. Plugins act at the events around them. A strategy limits tools and adds notes. It does not replace the loop.
- A policy cannot loosen the safety floor or the untrusted-text check.
- There is no plugin router (the choice of a cheaper model for a step). The built-in `/router` is separate.
- `PostModel` cannot change anything. `PostToolUse` cannot block.
- A plugin cannot add UI panels. A slash command can only use `say`, `ask` and `run`.
- Plugins are not sandboxed (see the safety section).

## Limits and common problems

- The loop order (steer, budget, compact, model, tools, verify) and the permission engine are fixed. Plugins act at the events around them.
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
- Try the new recipes in the [Cookbook](cookbook.md): finish gate, policy, strategy, CI gate and chaos.
