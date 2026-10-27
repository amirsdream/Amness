# Amness

**A terminal coding agent for any model that does not take "done" on faith.** It checks what the model claims against what actually happened, asks before anything risky, and shows every step in a full-screen interface. OpenAI, Claude and local models. No runtime dependencies.

[![CI](https://github.com/amirsdream/Amness/actions/workflows/ci.yml/badge.svg)](https://github.com/amirsdream/Amness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933)

<p align="center"><img src="docs/images/chat.png" alt="Amness full-screen interface: cards, diff, sidebar, input panel" width="900"></p>

## Quick start

You need **Node 22.18+**, git, and an API key (OpenAI or Anthropic) or a local model server.

```bash
git clone https://github.com/amirsdream/Amness.git && cd Amness && npm install
export OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY=sk-ant-...
npm link                              # gives you the `amness` command
cd ~/your-project && amness           # start a conversation in your project
```

```bash
amness "fix the failing test"         # start with a prompt
amness -c                             # continue the last conversation here
amness --provider ollama --model qwen2.5-coder:7b     # a local model, no key needed
amness demo                           # a scripted tour of the guardrails, no key needed
```

First launch without a key runs a short setup wizard. Inside the chat: `/help` lists everything, `Shift+Tab` changes how much it may do without asking, `Ctrl+P` opens the command palette.

## What you get

- **It checks itself.** A finish is compared with a record of what really ran (edits, commands, exit codes), your `verify` command must pass, and an optional independent reviewer can object. Loops, stalls and malformed calls are caught and corrected.
- **It asks first, and you can undo.** Edits show their diff before they apply. Risky commands need approval, a safety floor holds even in `yolo` mode, an opt-in OS sandbox enforces it, and `/undo` puts the working tree back after shell commands too.
- **It stays cheap.** Output is condensed, old context is trimmed in one cut so your prompt cache keeps hitting, memory notes are ranked and merged, and an opt-in router sends exploration to a cheaper model.
- **It is measurable.** `amness eval` runs your tasks under any combination of guards and reports paired statistics and cost per solved task, so every claim above can be tested on your own work.
- **It is yours to extend.** Hooks, skills, custom subagents, `AGENTS.md`, MCP servers, your own slash commands and a library API.

## Documentation

[Using the chat](docs/usage.md) · [Features in depth](docs/features.md) · [Providers and local models](docs/providers.md) · [Headless and CI](docs/headless.md) · [Library](docs/library.md) · [The agent loop](docs/agent-loop.md) · [Architecture](docs/architecture.md) · [Evaluation](docs/evaluation.md) · [Safety and privacy](docs/safety.md) · [Development](docs/development.md) · [Roadmap](ROADMAP.md) · [All pages](docs/index.md)

## Safety in four lines

- Data goes only to the provider you configure; there is no telemetry.
- File tools stay inside the project and must read a file before editing it. Shell commands are **not** sandboxed unless you turn the sandbox on (`/sandbox workspace`).
- Text from the web or tool servers is treated as data, secrets are masked before the model sees them, and a command copied from untrusted text needs your approval.
- Treat memory notes, hooks, skills and `AGENTS.md` from a repository you cloned as untrusted: project hooks and allow-rules only run after you approve that exact file.

## Limitations

- Developed on macOS and Linux; Windows is untested. Not on npm yet.
- Tests use scripted models and mock servers; behaviour against live providers has been checked by hand only, and several newer features (cache keep-alive, routing, the reviewer, semantic memory) have not yet been measured on a real model.
- Cost figures are estimates. Small local models vary widely in tool-calling quality.

More in [docs/development.md](docs/development.md). Licensed [MIT](LICENSE) © 2026 amirhossein jofreh.
