# Use it as a library

The harness works without the UI. Everything is exported from `src/index.ts`.

```ts
import { createCodeAgent, openai } from "amness";   // or a relative import of src/index.ts

const agent = createCodeAgent({
  model: openai({ model: "gpt-6.1-sol", effort: "high" }),
  cwd: "./my-repo",
  verify: "npm test",                                // "done" must be proven
  approve: ({ name, args, reason }) => false,        // deny risky calls (or ask a human)
});
const result = await agent.run("fix the failing test");
console.log(result.finished, result.text);
```

Building blocks: `createHarness` (the loop: validation and repair, finish gate, nudges, loop guard, budgets, steering, checkpoint/resume, `extract()` for validated JSON), `Registry` (tools that change mid-run, deferred tool search, MCP via `loadMcp`), `createCodeAgent`, `createDeepAgent` (planning, parallel context-isolated subagents, web search, citation checking), `MemoryStore` (ranked, learning memory; plug in an `Embedder` such as `openaiEmbedder` for semantic search), `evaluate`/`harnessVariant`/`analyze` (compare harness variants statistically on held-out checks), `warm()` (cache keep-alive), and the `openai`/`anthropic` model adapters. A model is just `(messages, tools, opts) => Promise<Message>`, so adding a provider is one function.

```ts
import { createHarness, defineTool, openai } from "amness";

const lookup = defineTool<{ id: string }>({
  name: "lookup", description: "Look up an order",
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  run: ({ id }) => db.orders.find(id),
  risky: false,
});
const h = createHarness({ model: openai(), tools: [lookup], verify: () => true, onEvent: console.log });
await h.run("What is the status of order 42?");
```

Because the CLI relies on Node's built-in TypeScript support, Amness is not published to npm yet; use it from a clone or `npm link`.
