# Providers and models

A *provider* is the service that runs the model (for example OpenAI or Anthropic), and Amness works with several of them, including models on your own computer.

In this page you will learn:

- which providers Amness supports and what the defaults are
- how to set an API key and switch provider or model
- how to run a local model with Ollama or another server
- how the OpenAI "Responses" and "Chat" APIs differ, and the environment variables you can set

## Supported providers

| Provider | Notes |
|---|---|
| **OpenAI** | The default provider. The default model is `gpt-6.1-sol`. Reasoning models use the **Responses API**. `/model` lists Sol, Astra, Terra, Luna and earlier models. |
| **Anthropic (Claude)** | Uses the native SDK adapter: streaming, adaptive thinking with `/effort`, automatic prompt caching and server-side refusal fallbacks. The default model is `claude-opus-5-5`. |
| **OpenRouter, Ollama, vLLM, LM Studio, any OpenAI-compatible server** | Use Chat Completions. Tool-calling quality depends on the model. |

The provider ids you can pass to `--provider` are `anthropic`, `openai`, `openrouter`, `ollama` and `custom`. The defaults for each id are in the table below.

| Id | Default base URL | Default model | Needs a key |
|---|---|---|---|
| `anthropic` | `https://api.anthropic.com` | `claude-opus-5-5` | yes |
| `openai` | `https://api.openai.com/v1` | `gpt-6.1-sol` | yes |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-4.1` | yes |
| `ollama` | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | no (optional) |
| `custom` | `http://localhost:8000/v1` | `my-model` | no |

The model list in `/model` (with prices per million tokens as shown in the picker) is in `cli/config.ts`. Costs shown in Amness are estimates.

**Prompt cache figures.** Amness reads the cached part of each request from the provider's answer, and the sidebar shows it as "cache". OpenAI and OpenAI-compatible servers report it as `cached_tokens`. Claude reports `cache_read_input_tokens`. DeepSeek reports `prompt_cache_hit_tokens`. Amness reads all three, so the cache and the cost are right on DeepSeek too. Covered by automated tests.

## Set your API key

**What it is.** A key is a secret text that proves you can use a provider.

**Why you would use it.** Without a key, a cloud provider refuses every request.

**How to set it.**

1. Choose one way.

   - Set an environment variable before you start Amness:

     ```bash
     export ANTHROPIC_API_KEY=sk-ant-...
     ```

     or

     ```bash
     export OPENAI_API_KEY=sk-...
     ```

   - Or start `amness`. On the first start it asks for a provider and a key. The key is hidden while you type.
   - Or type `/provider` in the chat, or run `amness settings`.

2. Start the chat.

   ```bash
   amness
   ```

**Example.** After you save a key, the setup runs a test call. You see a line like `✓ claude-opus-5-5 replied "OK" in 1.2s`. The time is an example.

**Limits and common problems.**

- Amness saves a key you type in your system's secure store: the macOS Keychain, the Linux keyring (`secret-tool`) or Windows DPAPI. In Docker or Kubernetes it saves nothing: pass the key as an environment variable or a `*_FILE` secret. On a Linux server with no keyring it uses `~/.amness/config.json` with file mode 600, which is not encrypted. See [Safety](safety.md).
- The environment variable wins over the saved file. `ANTHROPIC_API_KEY` is used when the provider is `anthropic`. `OPENAI_API_KEY` is used for **every other provider**, including `openrouter`. `OPENROUTER_API_KEY` is not read as a key.
- If the chat says "check your key with /provider", the provider answered with an authentication error (401 or 403).
- The test call checks that the model replies. It does not check that the model can call tools.

## Connect several providers

You can keep a key for every provider at the same time. Each key is saved on its own (in the Keychain, the Linux keyring or DPAPI), so switching provider never overwrites another key.

1. In the chat, type `/connect`. You see every provider with `●` (connected) or `○` (not connected), and where the key comes from: a saved key, or an environment variable.
2. Choose a provider. If it has no key, Amness asks for one (hidden). If it has one, you can use it now, replace the key, or remove the saved key. Local providers (Ollama, Custom) can have a key too, for a server that asks for one.
3. The menu stays open, so you can add the next provider. Press `Esc` when you are done.
4. Switch between them with `/provider`. Amness uses the saved key of the provider you pick, and asks only if there is none.

An environment variable wins over a saved key for its own provider: `ANTHROPIC_API_KEY` for Claude, `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`) for OpenRouter, and `OPENAI_API_KEY` for the others. Environment keys are never saved. **Limit:** a key from an older version moves to the provider that was active when you first start the new version, so check `/connect` once.

## Switch provider, model or effort

**How to switch in the chat.**

1. Type `/provider` and choose a provider. Amness asks for a key if it needs one.
2. Type `/model` and choose a model, or type `/model <id>`.
3. Type `/effort` to choose how much the model thinks before it answers. A higher effort can help on hard tasks and uses more tokens. Not every model has this setting.

**How to switch for one run.** Use flags (they also work with `amness run`):

```bash
amness run --provider anthropic --model claude-sonnet-5-5 "explain src/index.ts"
```

The flags `--provider`, `--model`, `--base-url`, `--effort` and `--api` are read by `amness run`. The interactive `amness` command does not read them. In the code, `amness --provider ollama` would send the extra words as your first message. Use `/provider` and `/model` in the chat. You can also set `AMNESS_MODEL` before you start.

**Check a model before you give it a job.** `amness doctor [model]` (in the chat: `/doctor [model]`) sends about ten short requests with test tools and no access to your files. It checks one tool call with typed arguments, two calls in one reply, a chain of three calls and whether the model stops when told, `tool_choice: "required"`, whether calls arrive as real tool calls or as text, whether the model corrects a call after an error, the window the server states, and how much faster a repeated prompt is (whether the server's prefix cache works). It then lists the jobs the model can take ("qualified for: compact, quarantine; not for: main (did not correct a call after an error)") and the profile settings it suggests, such as `"textToolCalls": true` or `"tier": "local"`. `amness doctor server:lab --write` (or `/doctor server:lab write`) saves them in `.amness/profile.json`, and `/models` then warns when you give the model a job it did not qualify for. Before it calls a paid provider, it asks.

**Other models for other jobs.** `/models explore|compact|review|cheap|approve|quarantine <model>` uses a different model for one job. The model can be on the main provider (`gpt-6.1-luna`), on another provider you are connected to (`anthropic:claude-haiku-5-5`), or on a saved server (`server:lab`, or `server:lab/<model>`). Each one uses its own key: a saved server's key is never sent anywhere else. `/models fallback <model>` names a model to use when the main one is overloaded or not reachable. See [Features: Models per job and a fallback](features.md#models-per-job-and-a-fallback).

## Run a local model

**What it is.** A local model runs on your own computer, through a server such as Ollama, LM Studio, vLLM or llama.cpp. Any server with an OpenAI-compatible `/v1` endpoint can work.

**Why you would use it.** Your code does not leave your computer, and usually you need no API key.

**How to use it with Ollama.**

1. Download a model that supports tool calling.

   ```bash
   ollama pull qwen2.5-coder:7b
   ```

2. Give the model a large enough context. Ollama picks the context length from your graphics memory when you do not set it: 4k tokens under 24 GiB, 32k from 24 to 48 GiB, and 256k above. For agents and coding tools Ollama recommends at least 64,000 ([Ollama docs](https://docs.ollama.com/context-length)). Set it on the server before it starts:

   ```bash
   OLLAMA_CONTEXT_LENGTH=65536 ollama serve
   ```

3. Choose Ollama in Amness. Use `amness settings`, or `/provider` in the chat, and pick "Ollama (local)". The base URL defaults to `http://localhost:11434/v1`.
4. Check the model with `/status`.

**Keep the server's prefix cache.** A local server reuses the start of the prompt it already processed only while that start is the same, byte for byte. When it changes, the server processes the whole prompt again: one report measured a median of about 69 seconds to the first token for a cold prompt against under 3 seconds with reuse (arXiv 2610.34241, abstract only). What helps:

- **A fixed tool list.** Normally a tool found with `tool_search` is added to the tool list, which sits at the start of every request, so the whole prompt is processed again. With **Fixed tool list** in Settings (`"stableTools": true`, `amness run --stable-tools`) the list stays the same: found tools run through a `call_tool` tool. Not measured yet: compare with `amness eval --variants full,tools:stable`.
- **One request at a time.** Amness sends one request at a time to a local server by default (`maxConcurrent`), so a second conversation does not push out the first one's cache.
- **Rewrites priced in time.** With cost-aware rewrites on (`/harness rewrites on`), Amness changes old messages only when that saves more than it costs. For a local model it uses the measured `cacheFactor` from `amness doctor --write` (how long a repeated prompt takes as a share of a cold one) instead of a token price.
- **The server's own settings.** llama.cpp keeps the prompt of each slot; with one slot (`--parallel 1`) your conversation keeps it, and `--cache-reuse` can reuse more of it. vLLM has automatic prefix caching (`--enable-prefix-caching`). Ollama keeps the cache while the model stays loaded (`OLLAMA_KEEP_ALIVE`). Check your server version's documentation: the names and defaults change between versions. Server options that go in each request (such as `cache_prompt` for llama.cpp) can be set with `"request"` in the model's profile.

**When Ollama cuts the prompt.** Ollama may cut a prompt that is longer than the context it loaded, without an error, so the model answers from part of the conversation. Amness reads the loaded context from Ollama's running-models list when the model is loaded (and the model's maximum only when it is not). During a run it also watches for the sign of a cut: the server reports the same prompt size twice while the conversation keeps growing. Then it works inside that size from now on, and tells you once how to fix it (raise the server's context length). Tested with a simulated server; not seen yet on a real Ollama.

For a one-shot run you can use flags. In the chat, the flags `--provider` and `--model` are not read (see above), so use `/provider` there.

```bash
amness run --provider ollama --model qwen2.5-coder:7b "list the TODO comments in src"
```

**How to use it with another server.**

```bash
amness run --provider custom --base-url http://localhost:1234/v1 --model <model-name> "your task"
```

**Save a server and pick it again.** Amness remembers each Ollama or custom server you set up, with its address, model and its own key. You set it up once, and then pick it by name. This works the same in the terminal and in the desktop app (model menu → **Switch provider…**).

1. Type `/provider` and pick **+ Custom OpenAI-compatible server…** (or **+ Ollama server…**).
2. Type the base URL, usually ending in `/v1`, for example `https://llm.example.com/v1`.
3. Type the API key or token if the server needs one. The key is hidden. Press `Enter` to skip it.
4. Pick the model. Amness asks the server for its models (`/v1/models`) and lists them. If the server lists none, type the model id.
5. Give the server a name, for example `lab`. The default is its host.

Next time, `/provider` lists `lab` with its address, model and key status. Pick it, and Amness switches without asking anything. In `amness run`, use `--server lab`.

**Manage saved servers.** Type `/connect` and pick a server. You can use it, add or replace its key, remove the key, change its address or model, or forget it (its key too). When you change the model with `/model` while a server is in use, the server remembers the new model.

**Keys stay with their server.** Each server has its own key, so a token for one server is never sent to another. If you passed `--provider` or `--base-url` to `amness run`, the saved server's key is not used.

**Upgrading.** If you used a custom or Ollama server before this version, Amness saves it on the first start as a server named after its host, with its key.

**Example: llama.cpp behind nginx.** Your server runs `llama-server` and nginx in front of it checks a token.

1. Type `/provider` and pick **+ Custom OpenAI-compatible server…**.
2. Base URL: the address nginx serves, ending in `/v1`, for example `https://llm.example.com/v1`.
3. Key: the token nginx (or `llama-server --api-key`) expects.
4. Model: pick it from the list the server returns.

Amness sends the key as `Authorization: Bearer <key>`. With no key, it sends no `Authorization` header. Amness also uses the token to ask the server for its context window (`/props`), so you do not have to type the window. nginx must pass `/v1/chat/completions`, `/v1/models` and `/props` through. If the server answers 401 (for example nginx's own 401 page), Amness asks for a key and sends your message again.

`OPENAI_API_KEY` also counts as the key for every Ollama and custom server. When it is set, Amness sends it to your server. Unset it if you do not want your OpenAI key sent there. Covered by automated tests (`test/keystore.test.ts`, `test/tui-app.test.ts`, `test/desktop.test.ts`).

**Set the context window.** A local server often runs a model with a small context window, such as 8,192 tokens. Amness keeps every request inside the window you give it. When the window fills up, it shortens old tool output first, then writes a handoff note and continues from that. Tell Amness the window in one of three ways:

- `contextWindow` in `~/.amness/config.json`, for example `"contextWindow": 8192`.
- The `AMNESS_CONTEXT_WINDOW` environment variable.
- `--context-window 8192` in `amness run`.

If you set nothing, Amness learns the window from the first "context length exceeded" error (the message usually states it), recovers, and remembers it for that model. The sidebar, the footer and `/tokens` show the percentage of this window. With a very small window the fixed part of each request (the system prompt and the tool list) already takes about 2,000 tokens, so an 8,192 window leaves room for only a few turns between handoffs. A window of 16,000 or more is much more comfortable. For a window of 16,384 or less Amness uses a small-window profile: a shorter system prompt, compact Skills and Memory blocks, and only the core tools (`read_file`, `list_files`, `grep`, `edit_file`, `write_file`, `sh`, `finish`) in the prompt. The other tools are found with `tool_search` when the model needs them. A bare "hi" then costs about 1,300 to 1,500 tokens.

**Limits and common problems.**

- Agent work needs **tool calling**, so choose a model that supports it. Small models can fail at it. Tool-calling quality varies a lot between local models.
- Small models may do better in `/mode plan`, with a token limit (`--max-tokens` in `amness run`, or `/budget` in the chat).
- Features that need an endpoint that Amness cannot assume on your computer (semantic memory, the Claude-only cache keep-alive) say so when you try them.
- `amness eval --variants ab` can show whether the guards help the model you chose. Whether they help is **not measured yet** for local models. See [Evaluating the harness](evaluation.md).
- Vision support for local models is guessed from the model name.

## Understand the OpenAI Responses and Chat APIs

**What it is.** OpenAI has two ways to talk to a model: the *Responses API* (`/v1/responses`) and the *Chat Completions API* (`/v1/chat/completions`). The adapter `src/openai.ts` speaks both.

**Why it matters.** Since GPT-5.4, Chat Completions rejects function tools together with reasoning (`400: Function tools with reasoning_effort are not supported ... use /v1/responses`). Current reasoning models therefore need Responses.

**How to choose.** Type `/api auto`, `/api responses` or `/api chat`, or pass `--api` to `amness run`. `auto` is the default.

| Mode | What it does |
|---|---|
| `auto` | Uses Responses for reasoning models on `api.openai.com`, and Chat Completions elsewhere. It corrects itself while it runs (see below). |
| `responses` | Always uses `/v1/responses`. |
| `chat` | Always uses `/v1/chat/completions`. This is what Ollama, vLLM and most gateways use. |

In `auto` mode Amness fixes these cases for you:

- If a server says to use `/v1/responses`, Amness switches and remembers.
- If a gateway has no `/responses`, Amness goes back to chat and uses the documented `reasoning_effort: "none"` workaround.
- If a server refuses an option (reasoning summaries for an unverified organisation, an unsupported effort, or `prompt_cache_key`), Amness drops that option once. It does not fail every request.

**Privacy detail.** In Responses mode the requests are stateless (`store: false`), so nothing is kept on the server side. Amness sends encrypted reasoning items back with each tool result, so multi-step tool use keeps its reasoning. Reasoning summaries stream into the status area while the model thinks. A model switch never replays another model's reasoning.

## Environment variables

| Variable | What it does |
|---|---|
| `OPENAI_API_KEY` | The key for every provider except `anthropic` (and for OpenRouter when `OPENROUTER_API_KEY` is not set). |
| `OPENROUTER_API_KEY` | The key for `openrouter`. |
| `ANTHROPIC_API_KEY` | The key for `anthropic`. |
| `OPENAI_BASE_URL` | The base URL for non-Claude providers. |
| `AMNESS_MODEL` | The model id. It wins over the saved config. |
| `AMNESS_CONTEXT_WINDOW` | The model's context window in tokens (for a small local model). It wins over the saved config. |
| `AMNESS_HOME` | The config folder. The default is `~/.amness`. |
| `AMNESS_UI` | `full` or `inline`. |
| `AMNESS_EMBED_MODEL` | The embedding model for semantic memory. The default is `text-embedding-3-small`. |
| `TAVILY_API_KEY` | Better web search for the research agent. |
| `NO_COLOR` | Turns colours off. |

## Related pages

- [Using the chat](usage.md): the `/provider`, `/model`, `/effort`, `/api` and `/models` commands.
- [Headless and CI](headless.md): choose the provider in scripts.
- [Budgets and subagents](budgets.md): rate limits and token caps.

## Next steps

- [Getting started](getting-started.md)
- [Using the chat](usage.md)
- [Headless and CI](headless.md)
