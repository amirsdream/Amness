# Run Amness on Terminal-Bench 2.0 with Harbor

[Harbor](https://pypi.org/project/harbor/) is the harness of Terminal-Bench 2.0: it starts each task in a Docker container, runs an agent in it, and checks the result with the task's own tests. `amness_agent.py` lets Harbor run Amness.

For long evaluations (resumable campaigns, a live view of each run's conversation, controls in the browser, and harness checks on every run), use [Amness Evaluation Studio](https://github.com/amirsdream/amness-eval-studio). It uses this adapter.

In this page you will learn:

- how to run one task, and then a whole dataset
- how to choose the model, the guards and plugins for a run
- where the results are

## Before you start

You need Docker running, `uv`, and Node 22 (to pack Amness). Install Harbor once:

```bash
uv tool install harbor
```

## Run one task

From the root of the Amness repository:

```bash
PYTHONPATH=bench/harbor harbor run -d terminal-bench@2.0 -l 1 -n 1 \
  -a amness_agent:Amness -m openai/gpt-6-luna -o .amness/harbor/jobs
```

The model is `provider/model`. The provider is `openai`, `anthropic`, `openrouter`, `ollama` or `custom`. The key comes from your environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `AMNESS_API_KEY` for any provider.

For your own server (llama.cpp, vLLM), give its address and let the container reach it:

```bash
PYTHONPATH=bench/harbor harbor run -d terminal-bench@2.0 -l 1 -n 1 \
  -a amness_agent:Amness -m custom/qwen-vllm \
  --ak endpoint=http://192.168.1.20:8000/v1 --allow-agent-host 192.168.1.20
```

By default the adapter packs **this working tree** (`npm run build` and `npm pack`) and installs that in the container, so a run tests the code you have now. Use `--ak package=0.5.2` to test a published version instead.

## Choose what runs

| Option | What it does |
|---|---|
| `--ak off=nudge,compact` | Switch these guards off (an ablation). The names are those of `/harness`. |
| `--ak plugin=path/a.mjs,path/b.mjs` | Load these plugin files for the run. |
| `--ak effort=high` | Reasoning effort. |
| `--ak max_steps=60` | The most model turns. |
| `--ak max_tokens=300000` | The token cap for the run. |
| `--ak context_window=32768` | The model's window, for a small local model. |
| `--ak tool_choice=required` | A tool call at every step (the server constrains the output to a valid call). |
| `--ak thinking_budget=4096` | The most thinking tokens per model request, for a slow local server (llama.cpp). |
| `--ak request='{"temperature":0.6}'` | Extra fields for every model request. |
| `--ak runtime=off` | Install Node and Amness in every container (by default they are installed once on the host into a cached bundle that each container unpacks). |
| `--ak api=chat` | The OpenAI wire API (`auto`, `responses`, `chat`). |
| `--ak verify="pytest -q"` | A command that must pass before Amness may finish. |
| `--ak explore_model=server:lab` | A model for one job (Amness 0.8.0+): `explore_model`, `compact_model`, `review_model`, `cheap_model`, `approve_model`, `quarantine_model`, `advisor_model`, `fallback`. A model is an id on the main provider, `provider:model` or `server:<name>`. |
| `--ak servers=lab=http://192.168.1.20:8000/v1` | Save servers in the container, so `server:<name>` works there. Give `name=url` pairs, or JSON (`[{"name":"lab","baseUrl":"…","model":"…"}]`). Without a model, the server uses the main model. |
| `--ak ladder=server:lab,openai:gpt-6-luna` | The recovery ladder: models, cheapest first (`ladder_start` picks the first one). |
| `--ak stable_tools=true` | The fixed tool list. Also `router`, `subagents` and `explore_ranges` (each `true`). |
| `--ak tier=local` | The model's tier (`local`, `mid`, `frontier`). With `text_tool_calls=true`, tool calls the model writes as text are taken. `profile='{…}'` sets any profile field of the main model (jobs on other models keep their own). |
| `--ak local_weight=0.1` | How much a token of a local model counts against the token cap (0 to 1). |
| `--ak max_time=600` | A time limit in seconds. By default the adapter reads the task's own limit and gives Amness that minus a margin, so Amness wraps up and reports before Harbor stops it. |

Harbor's own options choose the tasks: `-i <glob>` and `-x <glob>` include and exclude task names, `-l <n>` limits the number, `-n <n>` sets how many run at once, `-k <n>` runs each task several times.

## Read the results

Each trial is a folder under the jobs folder (`-o`). In it, `agent/amness.jsonl` holds every event of the run, `agent/amness.trace.jsonl` the loop trace, and `agent/amness.stderr` the messages. The last line of `amness.jsonl` is the result: finished or not, steps, tokens (sent, cached, received), and the cost estimate. Harbor reads these numbers into its own result file.

## Limits

- A llama.cpp server with one slot (`/props` shows `total_slots`) answers one request at a time. Run one task at a time (`-n 1`, the default of `run.sh`): with more, every trial waits in the queue and runs out of time.

- The container needs internet access to install Node and Amness.
- `--ak plugin=...` copies only the named files into the container, so a plugin that imports other local files does not work there.
- Measured results are not published here yet.
