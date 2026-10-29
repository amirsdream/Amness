# Development and limitations

This page shows you how to run the tests, where the code lives, how to add a feature, and what Amness cannot do yet.

In this page you will learn:

- how to run the type check and the tests
- what each folder contains
- how to add a tool, a guard or a command
- the known limits of the project

You need Node.js 22.18 or newer (the `engines` field in `package.json`) and `git`. The pseudo-terminal tests also need `python3`.

## Run the tests

**What it is.** The project has a type check, unit tests, UI tests, and tests that run the real program in a pseudo-terminal. A *pseudo-terminal* is a fake terminal that a script can type into and read from.

**Why you would use it.** Run them before every change. CI runs the same commands on every push to `main` and every pull request.

**How to use it.**

1. Install the packages:

```bash
npm install
```

2. Check the types. This runs `tsc --noEmit` over `src`, `cli`, `examples` and `test`:

```bash
npm run typecheck
```

3. Run the tests. This uses the Node.js built-in test runner on `test/**/*.test.ts`, with a 180 second limit per test:

```bash
npm test
```

4. Run the terminal tests (needs `python3`). This starts the real `amness` program in a pseudo-terminal against a mock server:

```bash
npm run test:pty
```

5. Run one test file:

```bash
node --test test/permissions.test.ts
```

**Example.** When all tests pass, the summary at the end of `npm test` shows `fail 0`, and the command exits with code 0. The exact format depends on your Node.js version.

**Limits and common problems.**

- The Linux sandbox tests skip themselves when Bubblewrap cannot create namespaces. CI has one extra step that sets `AMNESS_REQUIRE_SANDBOX=1`, so a skipped sandbox test shows up there. This step is informational and does not fail the build.
- The tests do not call real model APIs. They use scripted models and mock HTTP servers (see below). Use `amness eval` against a real model to measure behavior. See [Evaluating the harness](evaluation.md).
- Some tests set `AMNESS_HOME` to a temporary folder. If you run Amness by hand while testing, set `AMNESS_HOME` too, so you do not change your real `~/.amness`.

## Know what CI runs

The file `.github/workflows/ci.yml` has these jobs:

| Job | What it does |
|---|---|
| `test` | `npm ci`, `npm run typecheck`, `npm test` on Node 22 and Node 24, with Bubblewrap installed |
| `terminal` | `python3 test/pty/tui.py` on Node 24 |
| `package` | `npm pack`, installs the tarball in a new folder, runs `npx amness --version`, and checks that `import("amness")` exports `createCodeAgent` |
| `docker` | builds the `Dockerfile`, runs `--version` and `eval --selftest --only off-by-one` |
| `windows` | `npm run typecheck` and `npm test` on Windows. It is informational (`continue-on-error`) |
| `action` | runs the GitHub Action (`action.yml`) with no API key and checks that it reports instead of crashing |

A second workflow, `.github/workflows/publish.yml`, runs type check and tests, then `npm publish`, when you push a tag that starts with `v`. It needs an `NPM_TOKEN` secret. Whether the package is published on npm is not verified here.

## Find your way around the project

| Path | What is in it |
|---|---|
| `src/` | The library: the loop (`harness.ts`), the coding agent (`code.ts`), the research agent (`deep.ts`), model adapters (`openai.ts`, `anthropic.ts`), permissions, sandbox, secrets, hooks, plugins, memory, evals. `src/index.ts` exports everything |
| `cli/` | The program: `amness.ts` is the entry point. `headless.ts` is `amness run`. `evalcli.ts` is `amness eval`. `config.ts` reads `~/.amness/config.json`. `cli/tui/` is the chat interface (`app.ts`, `commands.ts` for slash commands, `full.ts` for the full-screen view) |
| `test/` | Tests, one file per area, for example `permissions.test.ts`, `sandbox.test.ts`, `taint.test.ts`, `harness.test.ts`. UI tests start with `tui-`. |
| `test/helpers/` | `vterm.ts` (a small VT100 emulator that reads the screen back) and `apprig.ts` |
| `test/pty/tui.py` | The pseudo-terminal tests |
| `test/fake-mcp.mjs` | A fake MCP server for tests |
| `examples/` | Runnable examples: `code.ts`, `research.ts`, `eval.ts`, `cases.ts`, `plugins/house-rules.ts` |
| `docs/` | These pages. Read [How we write the documentation](writing-guide.md) before you edit them |
| `dist/` | Build output from `npm run build`. Do not edit it |

For the layers and how the screen is drawn, see [Architecture](architecture.md).

## How the tests work

- The UI tests start the real `App` class, send fake key presses, and read the screen back through `test/helpers/vterm.ts`. They check layout, cursor place and redraw, not only text.
- Model providers are tested with scripted models and mock HTTP servers. One mock reproduces the OpenAI error "Function tools with reasoning_effort are not supported" (see `test/pty/tui.py`).
- Many tests use a scripted model. This is a function that returns prepared answers, so a test is fast and repeatable.

## Add a feature

**1. Add a tool for the coding agent.**

1. Open `src/code.ts`. Tools are made with `defineTool` and listed in `codeTools`.
2. Give the tool a `name`, a `description`, a JSON `schema`, a `run` function, and the flags that fit: `readOnly: true` for tools that change nothing, `risky` for tools that need approval, `untrusted: true` for tools that return text from outside.
3. Write a test in `test/` that uses a scripted model.
4. Run `npm run typecheck` and `npm test`.

If you only need a tool for yourself, write a plugin instead. A plugin needs no change to the source. See [Plugins](plugins.md).

**2. Add a guard to the loop.**

1. Open `src/harness.ts`. The loop is the function `run` inside `createHarness`.
2. Add the guard name to the `Guard` type, so `off` and `amness eval` can switch it off. Also add it to the `GUARDS` list in `src/profiles.ts`.
3. Emit an event with `emit(...)` so the chat and traces can show it. Add the event to the `Event` type.
4. Test it with a scripted model that makes the mistake. Add a case to `src/evalcases.ts` if you want to measure it with `amness eval`.

**3. Add a slash command.**

1. Open `cli/tui/commands.ts`. Each command is an object with `name`, `help` and `run`.
2. Add yours. Run the program and type `/help` to see it.
3. Add a test in `test/tui-app.test.ts` or a similar file.

**4. Add a model provider.**

A model is a function `(messages, tools, opts) => Promise<Message>`. Write one function in a new file under `src/`, export it from `src/index.ts`, and test it with a mock HTTP server. The providers in `cli/config.ts` list what the chat can choose.

**Before you open a pull request.** Make sure `npm run typecheck` and `npm test` pass. Update the docs page that describes the feature, and keep to the [writing guide](writing-guide.md).

## Known limits

- **Platforms.** Amness is developed and tested on macOS and Linux terminals. The CI job for Windows is informational. There is no Windows sandbox.
- **Real providers.** The automated tests use scripted models and mock servers. Behavior against live provider APIs was checked by hand only. Provider APIs change. If one breaks, open an issue with the error text.
- **Cost figures.** They are estimates, not invoices. Cached input is assumed to cost about 10% of the input price. Some models have no price listed.
- **New features.** Cache keep-alive, semantic memory and `amness eval` against a real model are covered by tests with scripted models. They were not run against live provider APIs in the tests. Numbers quoted from papers belong to those papers. They are not measurements of Amness.
- **Semantic memory.** It sends note text and your messages to the embeddings endpoint of your provider. It needs an OpenAI-compatible provider. Claude has none.
- **Local models.** Tool-calling quality with small local models varies a lot.
- **Node.js.** Amness runs TypeScript directly with Node.js type stripping, so it needs Node 22.18 or newer. The package build in `dist/` is checked by the CI job `package`.
- **Docker.** CI builds the image and runs two commands in it. It does not run a full task.
- **Missing features.** The file [ROADMAP.md](../ROADMAP.md) lists what is done and what is planned.

## Related pages

- [Architecture](architecture.md)
- [Plugins](plugins.md)
- [Evaluating the harness](evaluation.md)
- [Use it as a library](library.md)

## Next steps

- Read how the loop works: [The agent loop](agent-loop.md)
- Add your own rules without changing the source: [Plugins](plugins.md)
- Return to the [documentation index](index.md)
