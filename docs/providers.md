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
| `ollama` | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | no |
| `custom` | `http://localhost:8000/v1` | `my-model` | no |

The model list in `/model` (with prices per million tokens as shown in the picker) is in `cli/config.ts`. Costs shown in Amness are estimates.

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

**Other models for other jobs.** `/models explore|compact|review|cheap <model>` uses a different model of the same provider for one job. `/models fallback <model>` names a model to use when the main one is overloaded or not reachable. See [Features: Models per job and a fallback](features.md#models-per-job-and-a-fallback).

## Run a local model

**What it is.** A local model runs on your own computer, through a server such as Ollama, LM Studio, vLLM or llama.cpp. Any server with an OpenAI-compatible `/v1` endpoint can work.

**Why you would use it.** Your code does not leave your computer, and you need no API key.

**How to use it with Ollama.**

1. Download a model that supports tool calling.

   ```bash
   ollama pull qwen2.5-coder:7b
   ```

2. Choose Ollama in Amness. Use `amness settings`, or `/provider` in the chat, and pick "Ollama (local)". The base URL defaults to `http://localhost:11434/v1`.
3. Check the model with `/status`.

For a one-shot run you can use flags. In the chat, the flags `--provider` and `--model` are not read (see above), so use `/provider` there.

```bash
amness run --provider ollama --model qwen2.5-coder:7b "list the TODO comments in src"
```

**How to use it with another server.**

```bash
amness run --provider custom --base-url http://localhost:1234/v1 --model <model-name> "your task"
```

In the chat, run `/provider`, pick "Custom OpenAI-compatible", and type the model id and the base URL when Amness asks.

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
| `OPENAI_API_KEY` | The key for every provider except `anthropic`. |
| `ANTHROPIC_API_KEY` | The key for `anthropic`. |
| `OPENAI_BASE_URL` | The base URL for non-Claude providers. |
| `AMNESS_MODEL` | The model id. It wins over the saved config. |
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
