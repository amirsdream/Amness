# MCP servers

An MCP server is a program that gives the agent more tools: GitHub, a database, a browser, your issue tracker. Amness speaks the Model Context Protocol (MCP) version `2026-07-28` and the older versions, over stdio (a program on your computer) and over HTTP (a server on the network).

The same servers work everywhere: in the terminal app, in the desktop app, in `amness run`, and in editors that use Amness through ACP.

## Add a server

```bash
amness mcp add github https://api.githubcopilot.com/mcp/ -H "Authorization: Bearer ${GITHUB_TOKEN}"
amness mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
amness mcp list
```

In the chat, `/mcp add <name> <url or command>` does the same. `/mcp` shows every server and its status.

| Command | What it does |
|---|---|
| `amness mcp add [options] <name> <url>` | A remote server (Streamable HTTP). `--transport sse` for the old HTTP+SSE servers. |
| `amness mcp add [options] <name> -- <command> [args…]` | A program started on your computer (stdio). |
| `amness mcp add-json <name> '<json>'` | One entry in `.mcp.json`'s format. |
| `amness mcp list` | Every server, where it comes from, and whether it connects. |
| `amness mcp get <name>` | One server's settings and its tools. |
| `amness mcp remove <name>` | Removes it. |
| `amness mcp enable <name>`, `disable <name>` | Switches one on or off for this project only. |

Options for `add`: `--scope local|project|user` (see below), `-e KEY=value` (stdio), `-H "Name: value"` (HTTP), `--headers-helper <command>`, `--timeout <ms>`.

In the chat:

| Command | What it does |
|---|---|
| `/mcp` | Every server: connected, waiting for trust, switched off or failed (with the error). |
| `/mcp add [--scope …] <name> <url or command…>`, `/mcp remove <name>` | Adds or removes a server, then connects. |
| `/mcp enable <name>`, `/mcp disable <name>` | On or off for this project. |
| `/mcp reconnect [name]` | Connects again (after the server restarted, or after you signed in). |
| `/mcp tools <name>` | The server's tools, and which ones ask before they run. |
| `/mcp <command…>` or `/mcp <url>` | Attaches a server for this session only. `/mcp off` detaches those. |

## Where servers are saved

| Scope | File | Who uses it |
|---|---|---|
| `local` (default) | `.amness/settings.local.json` in the project | Only you, only this project. Amness keeps the file out of git (it adds it to `.git/info/exclude`). |
| `project` | `.mcp.json` in the project | Everyone who clones the project. This is Claude Code's file, so a project that already has one works in Amness too. |
| `user` | `~/.amness/config.json` | You, in every project. |

If the same name is in two places, `local` wins over `project`, and `project` wins over `user`. The higher entry is used as a whole.

The files use the `mcpServers` format of Claude Code and Claude Desktop:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": { "DEBUG": "0" } },
    "issues": { "type": "http", "url": "${ISSUES_URL:-https://issues.example.com}/mcp", "headers": { "Authorization": "Bearer ${ISSUES_TOKEN}" } },
    "old": { "type": "sse", "url": "https://old.example.com/sse" }
  }
}
```

- `${VAR}` takes the value from your environment, and `${VAR:-default}` gives a default. If a variable is not set, Amness tells you.
- `headersHelper` is a command that prints a JSON object of headers, for example a token from your password manager. It runs when the server connects, and again after a 401 or 403 answer.
- `timeout` is the limit for one call, in milliseconds (the default is 10 minutes).
- `"disabled": true` keeps the entry but does not start it.

## Safety

- **A project's servers need your yes.** The servers in a cloned project's `.mcp.json` start only after you trust the project. The terminal app asks once, together with the project's hooks and permission rules. If the file changes, it asks again. `/trust` shows the state and asks again. Until then, `/mcp` shows them as waiting.
- **Your API keys stay yours.** In a remote server's address or headers, the keys of your model providers (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the others) are always empty. So a project file cannot send them to a server it names.
- **The agent cannot add servers.** `.mcp.json` is protected like `.amness/hooks.json`: the agent may read it, but it may not write it.
- **Tools that change things ask first.** A tool the server marks as destructive, or does not mark as read-only, needs your approval. Your permission rules work on MCP tools too (the name is `<server>__<tool>`).
- **Answers are data.** What an MCP tool returns is marked as untrusted. The taint check and quarantine (see [safety](safety.md)) apply to it.
- **A stdio server runs as you.** It gets your environment plus the `env` you give it. Only add servers you trust.

## In `amness run`

`amness run` starts your servers (`local` and `user`). It starts the project's `.mcp.json` servers only with `--trust-project`.

| Option | What it does |
|---|---|
| `--mcp-config <file or JSON>` | Servers for this run, in the `mcpServers` format. You can give it more than once. |
| `--strict-mcp-config` | Use only the `--mcp-config` servers. |
| `--no-mcp` | No MCP servers. |

## In an editor (ACP)

Editors such as Zed send their own MCP servers when they open an Amness session. Amness starts them (stdio, HTTP and SSE), plus yours, plus the project's if you trusted the project in the terminal app.

## Protocol details

- Version `2026-07-28` first: no handshake. The protocol version, the client name and the client's capabilities go with every request. On HTTP, the request also sends the `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` headers. If a tool's `x-mcp-header` is not valid, the tool is left out, with a warning.
- Older servers: Amness falls back to the `initialize` handshake (`2025-11-25`, with a session id on HTTP), and then to the old HTTP+SSE transport (`2024-11-05`), as the specification describes.
- A server that answers 401 is shown as needing sign-in.
- A server with more than 15 tools has them behind `tool_search`, so the prompt stays small.
