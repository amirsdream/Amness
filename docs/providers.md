# Providers and models

| Provider | Notes |
|---|---|
| **OpenAI** | Default model `gpt-6.1-sol`. Reasoning models use the **Responses API**. `/model` lists Sol, Astra, Terra, Luna and earlier models. |
| **Anthropic (Claude)** | Native SDK adapter: streaming, adaptive thinking with `/effort`, automatic prompt caching, server-side refusal fallbacks. Default `claude-opus-5-5`. |
| **OpenRouter, Ollama, vLLM, LM Studio, any OpenAI-compatible server** | Chat Completions. Tool-calling quality depends on the model. |

**Running a local model (Ollama, LM Studio, vLLM, llama.cpp).** Any server with an OpenAI-compatible `/v1` endpoint works:

```bash
# Ollama
ollama pull qwen2.5-coder:7b          # or any model that supports tool calling
amness --provider ollama --model qwen2.5-coder:7b     # base URL defaults to http://localhost:11434/v1

# LM Studio, vLLM, llama.cpp server, anything else
amness --provider custom --base-url http://localhost:1234/v1 --model <model-name>
```

Or run `/provider` inside the chat and pick "Ollama (local)" or "Custom OpenAI-compatible"; the choice is saved. No API key is needed for local servers. Agent work depends on **tool calling**, so pick a model that supports it; small models do better in `/mode plan` with a `--max-tokens` limit, and `amness eval --variants ab` shows whether the guards help the model you chose. Features that need an endpoint Amness cannot assume locally (semantic memory, Claude-only cache keep-alive) say so when you try them.

**Why Responses.** Since GPT-5.4, `/v1/chat/completions` rejects function tools together with reasoning (`400: Function tools with reasoning_effort are not supported … use /v1/responses`). The OpenAI adapter (`src/openai.ts`) speaks both APIs. `/api auto` (default) uses Responses for reasoning models on api.openai.com and Chat Completions elsewhere, and corrects itself at runtime: if a server says to use `/v1/responses` it switches and remembers; if a gateway has no `/responses` it returns to chat with the documented `reasoning_effort: "none"` workaround; an option a server refuses (reasoning summaries for an unverified organisation, an unsupported effort, `prompt_cache_key`) is dropped once instead of failing every request.

In Responses mode requests are stateless (`store: false`): nothing is retained server-side, and opaque reasoning items are replayed with each tool result so multi-step tool use keeps its reasoning. Reasoning summaries stream into the status area while the model thinks. A model switch never replays another model's reasoning.

Environment variables: `AMNESS_UI` (`full` or `inline`), `AMNESS_EMBED_MODEL` (embedding model for semantic memory, default `text-embedding-3-small`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `AMNESS_MODEL`, `TAVILY_API_KEY` (better web search for the research agent), `AMNESS_HOME` (config directory, default `~/.amness`), `NO_COLOR`.
