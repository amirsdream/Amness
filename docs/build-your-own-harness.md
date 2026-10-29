# Build your own harness

This tutorial starts with one small rule and ends with a custom harness that you have measured.

In this page you will learn:

- how to build a plugin step by step: a guardrail, a finish gate, a command, a status line and a loop rule
- how to add your own context rule and system prompt
- how to compare your harness with the built-in one, and how to read the result
- how to use the comparison as a check in CI, and what is safe to install

A *harness* is the code around the model: the loop, the tools, the rules and the checks. A *plugin* is a TypeScript file that changes the harness. You do not need to read the source code. You need Amness installed and a project folder (see [Getting started](getting-started.md)).

Each step ends with a check. Do the check before you go on.

## Step 1: Create a plugin and see it

**What you do.** Create a plugin file from a template and approve it.

1. In your project folder, run:

   ```bash
   amness plugin new my-harness
   ```

   Amness writes `.amness/plugins/my-harness.ts`. It never overwrites a file that exists.

2. Start Amness:

   ```bash
   amness
   ```

   Amness asks if you trust the plugin files in this project. A plugin runs with your full permissions, so read the file first. Choose "Yes, trust this version".

3. Check that it loaded:

   ```text
   /plugins
   ```

   You will see a line with `my-harness` and its description. The template also adds a `/my-harness` command. Type it. You will see `hello from the my-harness plugin`.

**Important.** Amness approves the exact content of your plugin files. After you edit a file, the approval no longer matches. Run `/reload-plugins`: Amness asks you to approve the new version, then loads it.

For the next steps, you replace the whole file. The complete file is at the end of step 7. In each step you add one property to the exported object.

Start with this file. It is a plain object. You do not need to import anything from Amness.

```ts
export default {
  name: "my-harness",
  description: "no curl, tests before finish, read first, short old tool output",
};
```

## Step 2: Add a guardrail

**What it is.** A *hook* is a function that Amness calls at a fixed point in the loop. `PreToolUse` runs before each tool call. If it returns `{ block: "..." }`, the call does not run.

**Why.** A rule in code holds every time. A rule in the prompt can be forgotten.

Add this inside the object:

```ts
hooks: {
  PreToolUse: ({ tool, args }: { tool: string; args: any }) =>
    tool === "sh" && /\bcurl\b/.test(String(args.cmd))
      ? { block: "curl is not allowed here. Use the project tools instead." }
      : undefined,
},
```

`sh` is the tool that runs shell commands. Its argument is `cmd`.

**Check.** Restart Amness and approve. Then type:

```text
Run curl -s https://example.com in the shell and show me the first line.
```

The agent gets this as the tool result, and the chat marks the call as denied:

```text
BLOCKED BY A HOOK: curl is not allowed here. Use the project tools instead.
Do not retry the same call; choose another approach or explain what you could not do.
```

The words the agent writes next will differ each time.

**Limit.** This is a text match. The agent can run `wget` or `python -c` instead. A real network rule needs more patterns, or the sandbox (see [Safety and privacy](safety.md)). If you want a crash in your rule to block the call, add `failClosed: true` to the plugin.

## Step 3: Add a finish gate

**What it is.** A *finish gate* is a check that runs when the agent calls `finish`. If it fails, the agent must keep working.

**Why.** The gate sees what really happened, not only what the agent says. `GateCtx` has `changed` (the files changed in this task) and `testsAfterLastEdit` (whether a test or build command ran after the last edit).

Add this inside the object:

```ts
gates: [{
  name: "tests-after-edit",
  check: (ctx: any) =>
    ctx.changed.length > 0 && ctx.testsAfterLastEdit === false
      ? "you changed files but did not run the tests after the last edit"
      : true,
}],
```

**Check.** Restart Amness, approve, and ask for a small edit without tests:

```text
Add a comment line at the top of README.md. Do not run anything.
```

When the agent calls `finish`, it sees:

```text
REJECTED by a hook: gate "tests-after-edit" (plugin my-harness) found problems:
- you changed files but did not run the tests after the last edit
```

**Limits.**

- A gate rejects the same task at most 2 times. Then the run finishes and Amness shows a warning. This stops a wrong gate from trapping the agent. Set `maxRejections` on the gate to change it.
- `changed` lists edits made with the file tools. Files changed by a shell command are not in it.
- `testsAfterLastEdit` can be `undefined` when Amness cannot tell. The rule above rejects only on `false`.

## Step 4: Add a slash command and a status line

**What it is.** A *slash command* is a `/name` command in the chat. The *status line* is a short text in the sidebar.

**Why.** A command starts a repeated job with one word. The status line shows a state you want to see all the time.

Add this inside the object:

```ts
commands: [{
  name: "tests",
  help: "run npm test and show the result",
  run: async (ctx: any) => {
    const r = await ctx.run("npm test", 120_000);
    ctx.say(r.code === 0 ? "tests pass" : "tests fail:\n" + r.output.slice(-1500));
  },
}],

status: ({ running }: { running: boolean }) => (running ? "working" : "ready"),
```

`ctx.run` runs a shell command and returns `{ code, output }`. `ctx.say` prints a line that the agent does not see. A command name that a built-in command already uses is skipped. That is why this one is not called `check`.

**Check.** Restart Amness and approve. Type `/tests`. You will see `tests pass` or `tests fail:` with the end of the output. The sidebar shows `my-harness: ready`. If you do not see the sidebar, type `/sidebar`. The status function must be fast, because the sidebar calls it often.

## Step 5: Change the loop

**What it is.** A *loop strategy* decides when the model may use which tools. It uses the `PreModel` hook, which runs before each model request. It can return `tools` (the only tools allowed in this turn) and `then` (a message to send if the model answers with text only).

1. Try the built-in strategies first:

   ```text
   /strategy plan-first
   ```

   With `plan-first`, the model writes a numbered plan at step 0 and may not call tools. Try a task. Then try `/strategy explore-then-act`, which allows only read tools for the first 6 steps. Turn it off with `/strategy off`.

2. Now write your own rule. Add this to the `hooks` object from step 2, next to `PreToolUse`:

   ```ts
   PreModel: ({ step }: { step: number }) =>
     step === 0
       ? { context: "Write a short numbered plan first. Do not call tools in this reply.", tools: [], then: "Good. Now carry out the plan." }
       : step < 3 ? { tools: ["list_files", "read_file", "grep", "repo_map", "find_refs", "impact", "finish"] } : undefined,
   ```

   At step 0 the model gets no tools and must write a plan. `then` makes Amness ask again after the plan. Without `then`, a text-only reply would end the run. In steps 1 and 2, only read tools and `finish` are allowed. From step 3 on, all tools work.

**Check.** Restart Amness, approve, and give a task that needs an edit. In the first turns, the agent writes a plan and then only reads. If it calls `edit_file` too early, it gets `ERROR: edit_file is not allowed in this phase`.

**Limits.** The model still sees the full tool list. Amness enforces the limit when the model calls a tool. Your rule costs one extra model call per request.

## Step 6: Add a context rule and your own prompt

**What it is.** The `context` function runs before every model request. It gets the message list and `{ step, promptTokens, budget }`. It may return a new list. `budget` is the share of the token cap used so far, from 0 to 1.

**Why.** Old tool output fills the context window. This rule shortens old output when the budget is half used.

Add this inside the object:

```ts
context: (msgs: any[], { budget }: { budget: number }) =>
  budget < 0.5
    ? undefined
    : msgs.map((m, i) =>
        i < msgs.length - 10 && m.role === "tool" && (m.content ?? "").length > 1000
          ? { ...m, content: m.content.slice(0, 500) + "\n[older output shortened]" }
          : m),
```

The rule keeps every message. It only shortens the text of old tool results. This keeps each tool call together with its result. If you remove messages, keep them in pairs, or the provider can reject the request.

**Your own prompt.** A prompt in the registry is a file with a name you can test.

1. Create the file:

   ```bash
   mkdir -p .amness/prompts
   echo "You are a careful coding agent. Make the smallest change that works. Say which command you ran to check it." > .amness/prompts/terse.md
   ```

2. In the chat, choose it:

   ```text
   /prompt terse
   ```

   The text replaces the whole system prompt for new conversations. `/prompt list` shows the ids. `/prompt off` brings back the built-in prompt. An id may use letters, numbers, `.`, `_` and `-`.

**Check.** Type `/prompt list`. You will see `terse`. Start a new conversation with `/clear` and ask what rules you gave it.

**Limit.** Your prompt replaces the built-in prompt. The built-in prompt has rules for tools and safety. Test a short prompt before you rely on it (step 7).

## Step 7: Measure it

So far you have a feeling that the harness is better. Now you measure it.

**What it is.** An *eval* runs the agent on tasks in fresh folders. A *held-out check* decides if each task is solved. The agent never sees the check. A *variant* is one harness setup. A *trial* is one more run of the same task.

**1. Write a task.** Add `cases` and `variants` inside the object:

```ts
cases: [{
  name: "small-fix",
  files: {
    "math.js": "exports.add = (a, b) => a - b;\n",
    "test.js": "const { add } = require('./math.js');\nif (add(2, 3) !== 5) { console.error('wrong'); process.exit(1); }\n",
  },
  task: "add() in math.js gives wrong results. Fix it. Run node test.js to check.",
  verify: "node test.js",
  check: async (dir: string) => {
    const { execSync } = await import("node:child_process");
    try {
      execSync("node -e \"const {add}=require('./math.js'); process.exit(add(2,3)===5&&add(-4,1)===-3?0:1)\"", { cwd: dir, stdio: "pipe" });
      return true;
    } catch { return "add() still gives wrong results"; }
  },
  solution: { "math.js": "exports.add = (a, b) => a + b;\n" },
}],

variants: { guarded: { off: [], verify: true } },
```

The `check` function gets the workspace folder. It returns `true` to pass, or text that explains the failure. It tests one more value than `test.js` does, so the agent cannot pass by tuning for the file it can see. `solution` is a known good fix. The variant `guarded` is the full harness, plus the hooks, gates, context rule and prompt of this plugin. The plugin that defines a variant is always active in it.

**2. Check the task. This calls no model and costs nothing.**

```bash
amness eval --plugin .amness/plugins/my-harness.ts --selftest
```

The last line must be `ok  small-fix`. Passing a file with `--plugin` counts as your approval of that file.

**3. Compare the variants.** This calls your model and costs tokens. Amness shows a plan and asks before it starts. Your task joins the 13 built-in tasks.

```bash
amness eval --plugin .amness/plugins/my-harness.ts --variants full,guarded --trials 3 --metrics diff-lines,tool-calls
```

That is 14 tasks, 2 variants and 3 trials: 84 sessions. Read the plan line before you accept.

**4. Read the table.**

- `pass [95% CI]` is the share of tasks solved. The *confidence interval* (CI) is the range where the true value probably lies.
- `tok/solved` is tokens per solved task. A *token* is a small piece of text that a model reads.
- Under it, Amness compares `guarded` with the first variant (`full`). `Δ pass` is the change in points. `W/L/T` counts tasks won, lost and tied. `verdict` is `better`, `worse` or `inconclusive`.
- The custom metrics table shows `diff-lines` (lines changed) and `tool-calls`. A smaller change that still passes is usually better.

`inconclusive` means the data cannot tell. It does not mean the variants are equal.

**Warning: the first runs are noisy.** A model gives different answers each time. Amness treats the task as the unit, so more trials do not help much. More tasks help. The report prints how large a pass-rate difference you can see. Amness computes it as `minDetectable` in `src/stats.ts`: about 2 divided by the square root of the number of tasks.

| Tasks | Smallest pass-rate difference you can detect |
|---|---|
| 14 | about 53 points |
| 25 | about 40 points |
| 44 | about 30 points |
| 98 | about 20 points |

With 14 tasks you will almost surely see `inconclusive` for pass rate. Use 3 or more trials to make the cost and metric numbers steadier. Add your own tasks from real failures (see [Evaluating the harness](evaluation.md#turn-a-real-failure-into-a-task)). Treat one run as a hint, not as proof.

To use the prompt in the comparison, add `prompt:terse` as a variant. For example: `--variants full,guarded,prompt:terse`.

### The complete plugin file

Put the pieces together. This file passed `--selftest`. Its hook, gate and context functions were also called directly with sample input. It was not run against a real model.

```ts
export default {
  name: "my-harness",
  description: "no curl, tests before finish, read first, short old tool output",

  hooks: {
    PreToolUse: ({ tool, args }: { tool: string; args: any }) =>
      tool === "sh" && /\bcurl\b/.test(String(args.cmd))
        ? { block: "curl is not allowed here. Use the project tools instead." }
        : undefined,
    PreModel: ({ step }: { step: number }) =>
      step === 0
        ? { context: "Write a short numbered plan first. Do not call tools in this reply.", tools: [], then: "Good. Now carry out the plan." }
        : step < 3 ? { tools: ["list_files", "read_file", "grep", "repo_map", "find_refs", "impact", "finish"] } : undefined,
  },

  gates: [{
    name: "tests-after-edit",
    check: (ctx: any) =>
      ctx.changed.length > 0 && ctx.testsAfterLastEdit === false
        ? "you changed files but did not run the tests after the last edit"
        : true,
  }],

  commands: [{
    name: "tests",
    help: "run npm test and show the result",
    run: async (ctx: any) => {
      const r = await ctx.run("npm test", 120_000);
      ctx.say(r.code === 0 ? "tests pass" : "tests fail:\n" + r.output.slice(-1500));
    },
  }],

  status: ({ running }: { running: boolean }) => (running ? "working" : "ready"),

  context: (msgs: any[], { budget }: { budget: number }) =>
    budget < 0.5
      ? undefined
      : msgs.map((m, i) =>
          i < msgs.length - 10 && m.role === "tool" && (m.content ?? "").length > 1000
            ? { ...m, content: m.content.slice(0, 500) + "\n[older output shortened]" }
            : m),

  cases: [{
    name: "small-fix",
    files: {
      "math.js": "exports.add = (a, b) => a - b;\n",
      "test.js": "const { add } = require('./math.js');\nif (add(2, 3) !== 5) { console.error('wrong'); process.exit(1); }\n",
    },
    task: "add() in math.js gives wrong results. Fix it. Run node test.js to check.",
    verify: "node test.js",
    check: async (dir: string) => {
      const { execSync } = await import("node:child_process");
      try {
        execSync("node -e \"const {add}=require('./math.js'); process.exit(add(2,3)===5&&add(-4,1)===-3?0:1)\"", { cwd: dir, stdio: "pipe" });
        return true;
      } catch { return "add() still gives wrong results"; }
    },
    solution: { "math.js": "exports.add = (a, b) => a + b;\n" },
  }],

  variants: { guarded: { off: [], verify: true } },
};
```

## Step 8: Use it as a regression gate and grade real sessions

**What it is.** A *regression gate* compares a new eval run with a saved one. It exits with code 1 when the result is clearly worse.

**Why.** You change the plugin, a prompt or the model. The gate tells you if something got worse.

1. Save a good run as your baseline:

   ```bash
   amness eval --plugin .amness/plugins/my-harness.ts --variants guarded --trials 3 --out evals/baseline.json
   ```

2. In CI, run again and compare:

   ```bash
   amness eval --plugin .amness/plugins/my-harness.ts --variants guarded --trials 3 --yes --gate evals/baseline.json
   ```

   Amness prints a `regression gate` block. The exit code is 0 when every variant is `ok`, and 1 when one fails.

The gate fails when the pass rate drops by more than 5 points (`--gate-tol`) and the whole interval is below zero. It also fails when tokens per solved task grow by more than 25 percent (`--gate-cost`). With few tasks, a real drop often gives only a warning. The gate is tested with scripted data. It has not been run in a real CI pipeline.

**Grade real sessions.** An eval uses tasks you wrote. `grade` scores sessions that really happened, from the traces in `.amness/traces`. It makes no model call.

```bash
amness plugin grade .amness/traces --plugin .amness/plugins/my-harness.ts
```

You will see one line per grader, such as `finished  mean 62%  over 8 session(s)`. The built-in graders are `finished`, `no-rejections`, `tool-errors`, `no-loops` and `verified-edits`. A plugin can add more with the `graders` field (see [Plugins](plugins.md#metrics-and-graders)). Note that `finished` scores 0 for a plain chat answer.

## Step 9: Stay safe

- **A plugin has your full permissions.** It can read files, run commands and use the network. The sandbox setting does not limit plugin code.
- **Trust prompt.** Before Amness asks, it shows one line per file about what the source seems to touch. For example: `my-harness.ts: runs shell commands`. This is a text scan, not a sandbox. A plugin can hide what it does. Read the file.
- **Approval is per content.** Any change to a project plugin file asks again. In headless runs, project plugins load only with `--trust-project`.
- **Add a plugin from someone else.** This copies the file into `.amness/plugins/` and does not run it:

  ```bash
  amness plugin add ./their-plugin.ts
  amness plugin add https://example.com/their-plugin.ts
  ```

  It accepts a file or an `https` URL, rejects files over 300 KB or without `export default`, and never overwrites a file. It prints what the file seems to touch. Amness still asks for your approval the first time it starts.

## What you built

- A guardrail that blocks `curl` in shell commands.
- A finish gate that refuses to finish after edits without a test run.
- A `/tests` command and a status line.
- A loop rule: plan first, then read only, then act.
- A context rule and a prompt (`terse`).
- An eval task and a variant, compared with `full` on a table with intervals.
- A baseline file for a CI gate, and a way to grade real sessions.

None of these rules is shown to be better yet. The table tells you what the data can and cannot say.

## Next steps

- [Plugins](plugins.md): every plugin field, the hook events, memory backends and model routing.
- [Evaluating the harness](evaluation.md): suites, ablations, custom tasks and the measured results.
- [Cookbook](cookbook.md): short recipes.
- [examples/plugins/house-rules.ts](../examples/plugins/house-rules.ts): a plugin with a tool, a prompt rewrite, a task and two variants.
- [Safety and privacy](safety.md)
