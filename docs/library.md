# Use it as a library

This page shows you how to use the Amness agent loop inside your own TypeScript program, without the terminal chat.

In this page you will learn:

- how to install the library and run a coding agent
- how to add your own tool and ask for approval
- how to set a budget, rules, hooks and a sandbox
- how to run the research agent and an evaluation

Everything is exported from `src/index.ts`. The code samples on this page were type-checked against the real types in `src/harness.ts` and `src/code.ts`. They were not run against a live model.

## Install the library

**What it is.** Amness runs TypeScript directly with Node.js type stripping. You need Node.js 22.18 or newer.

**Why you would use it.** You get the same guards as the chat (argument checks, verify gate, loop guard, budgets) inside a script, a server or a test.

**How to use it.**

1. Install the package in your own project:

```bash
npm install amness
```

2. Import what you need:

```ts
import { createCodeAgent, openai } from "amness";
```

To use the latest `main` before it is released, clone the repository, run `npm install && npm run build && npm pack`, and install the tarball it makes with `npm install ../Amness/amness-<version>.tgz`. You can also import the source directly, because Node.js can run `.ts` files: `import { createCodeAgent, openai } from "../Amness/src/index.ts";`.

The CI job `package` packs the tarball, installs it in a new folder, and checks that `import("amness")` works.

**Limits.** The Claude adapter needs the optional package `@anthropic-ai/sdk` (`npm install @anthropic-ai/sdk`). The OpenAI adapter uses plain `fetch` and has no dependency.

## Run a coding agent

**What it is.** `createCodeAgent` gives you an agent with file tools, a shell tool, memory and all guards. It works in one folder (`cwd`).

**How to use it.**

1. Create a file `fix.ts`:

```ts
import { createCodeAgent, openai } from "amness";

const agent = createCodeAgent({
  model: openai({ model: "gpt-6.1-sol", effort: "high" }),
  cwd: "./my-repo",
  verify: "npm test",                         // "done" must be proven by this command
  approve: ({ name, args, reason }) => false, // deny risky calls
});

const result = await agent.run("fix the failing test");
console.log(result.finished, result.text);
```

2. Set your key and run it:

```bash
export OPENAI_API_KEY=sk-...
node fix.ts
```

**Example.** If the tests pass after the fix, you see `true` and the summary the agent wrote. If the agent runs out of steps, you see `false` and a text that starts with `stopped:`.

**What `run` returns.** An object with `text`, `finished`, `steps`, `tokens`, `messages` and, when it stopped early, `stopped` (`"budget"`, `"maxSteps"`, `"aborted"`, `"stuck"` or `"blocked"`).

**Limits and common problems.**

- `approve` is called before every risky tool call. It must return `true`, `false`, or a string. A string is a denial that the agent reads. If you give no `approve`, risky calls are denied.
- Without `permissions: { mode }`, edits do not ask. Only shell commands on the risk list ask. For the chat behavior, pass `permissions: { mode: () => "default" }`. Modes are `"default"`, `"acceptEdits"`, `"plan"` and `"yolo"`.
- The default step limit is 40 (60 when `chat: true`). Change it with `maxSteps`.
- Memory is on by default. It writes to `.amness/memory` in `cwd` and to `~/.amness/memory`. Pass `memory: false` for a clean run.

## Add your own tool

**What it is.** A tool is an object made with `defineTool`. The model calls it by name. The `schema` is a JSON schema. Amness validates the arguments before `run` is called.

**How to use it.**

```ts
import { createHarness, defineTool, openai } from "amness";

const orders: Record<string, string> = { "42": "shipped" };

const lookup = defineTool<{ id: string }>({
  name: "lookup",
  description: "Look up the status of an order",
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  run: ({ id }) => orders[id] ?? "unknown order",
  readOnly: true,   // changes nothing, so it may run in parallel
});

const h = createHarness({
  model: openai(),
  tools: [lookup],
  verify: () => true,
  onEvent: (e) => console.error(e.kind),
});
const r = await h.run("What is the status of order 42?");
console.log(r.text);
```

The flags on a tool:

| Flag | Meaning |
|---|---|
| `readOnly` | Changes nothing. Safe in plan mode and in parallel |
| `risky` | `true`, or a function that returns `true` or a reason text. The call needs `approve` |
| `untrusted` | The output comes from outside. It is wrapped as data, and shell commands that copy from it need approval |
| `deferred` | Hidden until the model finds it with `tool_search`. Good when you have many tools |
| `when` | Shows the tool only while the function returns `true` |

**Limits.** Without `approve`, `createHarness` denies every risky tool call. `createHarness` has no file or shell tools. Use `createCodeAgent` for those, and pass your tools with `tools: [...]`.

## Set a budget, rules, hooks and a sandbox

**How to use it.**

```ts
import { Budget, Hooks, Permissions, createCodeAgent, openai } from "amness";

const cwd = "./my-repo";
const budget = new Budget({ maxTokens: 200_000, maxMs: 10 * 60_000 });

const agent = createCodeAgent({
  model: openai(),
  cwd,
  budget,
  sandbox: "workspace",                                   // "off" | "workspace" | "strict"
  rules: new Permissions({ deny: ["sh(git push*)", "edit(.env)"] }, cwd),
  hooks: Hooks.load(cwd, { trustProject: false }),       // only your ~/.amness/hooks.json
  check: "npx tsc --noEmit",                              // runs after each edit
  approve: () => false,
});

const r = await agent.run("add a --verbose flag");
console.log(r.finished, budget.tokens);
```

**Limits and common problems.**

- `rules` replaces the default. The built-in floor still applies when you pass your own `Permissions`. Passing `rules: false` switches the floor off too.
- `Hooks.load(cwd, { trustProject: true })` runs the commands in the project's `.amness/hooks.json`. Do this only for code you trust.
- If you ask for a sandbox that is not available (for example on Windows), shell commands fail with an error. They do not run unprotected.
- `taint` (`"ask"`, `"deny"` or `"off"`) and `redact` (`true` or `false`) control the text checks. See [Safety and privacy](safety.md).
- Call `await agent.procs?.dispose()` when you are done, so background processes stop.

## Choose a model

A model is a function `(messages, tools, opts) => Promise<Message>`.

```ts
import { anthropic, openai } from "amness";

const gpt = openai({ model: "gpt-6.1-sol" });
const local = openai({ baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b" });
const claude = anthropic({ model: "claude-opus-5-5" });   // needs @anthropic-ai/sdk
```

To add another provider, write one function that returns a `Message` (`{ role: "assistant", content, tool_calls? }`) and, if you can, `usage`. If the provider gives no token counts, Amness estimates them (about 4 characters per token).

## Continue, stop and resume a run

- `checkpointFile: "state.json"` saves the transcript every turn. Later, `agent.run(task, { resume: true })` continues from it.
- `signal: controller.signal` stops the run at the next safe point.
- `agent.followUp(result, "now also update the docs")` continues the same conversation.
- `agent.exportBundle(result, "session.json")` saves a portable session. `agent.run(task, { bundle: "session.json" })` continues it on another machine.

## Get checked JSON from a model

`createHarness(...).extract(prompt, schema)` asks for JSON and checks it against a schema. It sends validation errors back and tries up to 3 times. It throws an error if the JSON is still wrong.

```ts
import { createHarness, openai } from "amness";

const h = createHarness({ model: openai() });
const data = await h.extract<{ name: string; age: number }>(
  "Ada Lovelace was 36 when she died.",
  { type: "object", required: ["name", "age"], properties: { name: { type: "string" }, age: { type: "integer" } } },
);
console.log(data.name, data.age);
```

## Run the research agent

`createDeepAgent` plans, sends work to subagents, searches the web and writes `/report.md`. It rejects a report that cites URLs the agents never saw.

```ts
import { createDeepAgent, openai } from "amness";

const agent = createDeepAgent({
  model: openai(),
  dir: ".amness",   // files persist between runs
});
const r = await agent.run("Compare two ways to cache HTTP responses in Node.js");
console.log(r.report ?? r.text);
```

It uses `TAVILY_API_KEY` for search when set. Otherwise it reads DuckDuckGo's HTML page, which can break. Search queries and page requests leave your machine. See [Safety and privacy](safety.md).

## Attach an MCP server

```ts
import { createCodeAgent, loadMcp, openai } from "amness";

const mcp = await loadMcp("npx", ["-y", "@modelcontextprotocol/server-filesystem", "."]);
const agent = createCodeAgent({ model: openai(), cwd: ".", tools: mcp.tools, approve: () => false });
await agent.run("list the files");
mcp.close();
```

Tools from the server get the prefix of the command name, then `__`, then the tool name. Tools that the server marks as changing things need approval. The server gets your full environment, and the output is treated as untrusted.

## Compare harness variants

`evaluate` runs tasks with different harness settings and gives a table. A `Case` has `files`, a `task`, and a held-out `check` that the agent never sees.

```ts
import { codeVariants, evaluate, openai, type Case } from "amness";

const cases: Case[] = [{
  name: "rename-word",
  files: { "a.txt": "one\n" },
  task: "Change the text in a.txt from 'one' to 'two'.",
  check: (dir) => import("node:fs").then((fs) => fs.readFileSync(`${dir}/a.txt`, "utf8").trim() === "two"),
}];

const { table } = await evaluate(cases, codeVariants(openai()), { trials: 3 });
console.log(table);
```

This calls the model many times and costs money. For statistics and ablations, use the command line. See [Evaluating the harness](evaluation.md).

## Examples in the repository

| File | What it shows |
|---|---|
| `examples/code.ts` | A coding agent with a terminal approval prompt, `--verify`, `--resume`, `--self-extend` and `--mcp` |
| `examples/research.ts` | The research agent |
| `examples/eval.ts` | A pass-rate table with `codeVariants` |
| `examples/cases.ts` | The built-in evaluation cases |
| `examples/plugins/house-rules.ts` | A plugin with hooks, a tool, a case and variants |

Run one with Node.js, for example:

```bash
OPENAI_API_KEY=sk-... node examples/code.ts ./my-repo "fix the failing test" --verify "npm test"
```

## Related pages

- [The agent loop](agent-loop.md) for what the loop does each turn
- [Plugins](plugins.md) for rules you can load without changing code
- [Safety and privacy](safety.md) for approval, rules and the sandbox
- [Budgets and subagents](budgets.md) for `Budget`

## Next steps

- Try the examples: [Cookbook](cookbook.md)
- Measure a change: [Evaluating the harness](evaluation.md)
- Understand the layers: [Architecture](architecture.md)
