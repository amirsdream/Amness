# Amness as a service: `amness serve` and the HTTP API

`amness serve` keeps Amness running. One server gives you two things:

- **The app in your browser.** The same window as the desktop app, in any browser: on this computer, or on your phone and other computers on your home network.
- **An HTTP API (`/v1`).** Scripts, CI jobs, the Evaluation Studio and other agents can start sessions, send messages, watch what happens and answer approvals.

The sessions are the terminal app's own sessions. Commands, approvals, plugins, MCP servers, hooks, memory and the conversation history work as in the terminal and the desktop app, and conversations are saved in the same place.

## Start it

```bash
cd ~/code/api && amness serve
```

```text
● amness serve 0.9.0 · this computer only · folders: /home/me/code/api
  app   http://127.0.0.1:4747/#t=3q…
  API   http://127.0.0.1:4747/v1/  (Authorization: Bearer <token>; docs/api.md, GET /v1/openapi.json)
```

Open the `app` address in a browser. The part after `#t=` is the token. It stays in your browser and is never sent in the address.

| Option | What it does |
|---|---|
| `--host <address>` | Where to listen. The default `127.0.0.1` means this computer only. `0.0.0.0` means every network this computer is on. |
| `--port <n>` | The port (default `4747`). |
| `--root <folder>` | Folders that sessions may use. You can give it more than once. The default is the folder you start it in. `--root ~` allows all your folders. |
| `--allow-host <name>` | Another name the server is reached by, for example the domain of a reverse proxy. |
| `--tls-cert <file> --tls-key <file>` | Serve HTTPS. |
| `--max-sessions <n>` | Open API sessions at once (default 16). |
| `--log <file>` | The request log: time, address, method, path, status. The default is `~/.amness/serve.log`; `--log off` turns it off. |

`amness serve token` prints the token. `amness serve token --rotate` makes a new one: restart the server, and give the new token to your clients.

## Keep it running: `amness service`

```bash
amness service install --host 0.0.0.0 --root ~/code      # the same options as amness serve
amness service status
```

`install` writes a service for your operating system and starts it. It starts again when you log in, and again if it stops with an error.

| System | What Amness writes | Notes |
|---|---|---|
| macOS | `~/Library/LaunchAgents/dev.amness.serve.plist` (launchd) | Runs while you are logged in. |
| Linux | `~/.config/systemd/user/amness.service` (systemd, your user) | To keep it running when you are logged out: `loginctl enable-linger $USER`. |
| Windows | A task "Amness serve" that runs when you sign in | |

Its output goes to `~/.amness/serve.out.log` (`amness service logs`). The other commands are `start`, `stop`, `restart`, `uninstall`. `install --dry-run` shows what it would write and run, and changes nothing. Nothing runs as administrator or root.

## Open it in the desktop app

```bash
amness-desktop --connect http://192.168.1.20:4747 --token <token>
```

The desktop window shows the running server instead of starting an agent on this computer. The token can also come from the address (`#t=…`) or from `AMNESS_SERVE_TOKEN`. Amness checks that the server answers and that the token is right before it opens the window.

## Use it from your phone or another computer

```bash
amness serve --host 0.0.0.0 --root ~/code
```

Amness prints one address for each network it is on (for example `http://192.168.1.20:4747/#t=…`). Open it on your phone.

Before you do this, read these points:

- **Whoever has the token can run commands in those folders as you.** Keep the token secret. Give `--root` only the folders you need.
- **Without HTTPS, the traffic is not encrypted.** Someone on the same network who can read the traffic can read the token. Use `--tls-cert` and `--tls-key`, or put a reverse proxy with TLS in front (Caddy, nginx), and use it only on networks you trust. A reverse proxy's domain needs `--allow-host`.
- **Other websites cannot use it.** The server only answers requests addressed to its own names and addresses. This blocks "DNS rebinding", where a web page in your browser tries to reach a local server. It also refuses requests from pages of other origins. After 20 wrong tokens from one address in a minute, that address waits a minute.
- **Approvals still need a person.** A session asks before risky actions, in the same way as the terminal. The browser shows the question, and an API client answers it (see below). Choose `acceptEdits` or `yolo` only if you know why you need it. The safety floor (see [safety](safety.md)) applies in every mode.

## The API in five calls

```bash
T=$(amness serve token); A=http://127.0.0.1:4747/v1
S=$(curl -s -X POST $A/sessions -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"title":"from curl"}' | jq -r .id)
curl -s -X POST $A/sessions/$S/messages -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"text":"what does this project do?","wait":true}' | jq -r .text
curl -s $A/sessions/$S -H "Authorization: Bearer $T" | jq .status
curl -s -X DELETE $A/sessions/$S -H "Authorization: Bearer $T"
```

With `"wait": true`, the call returns when the turn ends (`text` is the answer). It also returns when the session waits for you (`session.status` is `waiting`, and `session.dialog` is the question). Without `wait`, it returns at once, and you follow the events.

### Routes

Every route except `/v1/health` and `/v1/openapi.json` needs `Authorization: Bearer <token>` (or the header `x-amness-token`). `GET /v1/openapi.json` describes all of them (OpenAPI 3.1), so you can generate a client in any language.

| Route | What it does |
|---|---|
| `GET /v1/health` | `{ ok, version, sessions }` |
| `GET /v1/sessions` | The open sessions. With `?saved=<folder>`, also the conversations saved there. |
| `POST /v1/sessions` | Starts a session. Optional fields: `cwd` (under a `--root`), `resume` (the id of a saved conversation), `model` (an id, `provider:model` or `server:<name>`), `mode` (`default`, `acceptEdits`, `plan`, `yolo`), `title`. |
| `GET /v1/sessions/{id}` | Its state: `status` (`idle`, `running`, `waiting`), model, mode, turns, `dialog`, `lastAnswer`. |
| `POST /v1/sessions/{id}/messages` | `{ text, wait?, timeoutMs? }`. The text can also be a slash command, `!shell` or `#note`, as in the terminal. |
| `GET /v1/sessions/{id}/items?since=<id>` | The transcript: `user`, `assistant`, `tool` (name, arguments, status, result, the diff of an edit), `thinking`, `notice`, `summary`, `raw` (command output). |
| `POST /v1/sessions/{id}/dialog` | Answers the open question: `{ id, value }`. `value` is an option number for `choice` (0 is the first), an item number for `pick`, the text for `input`, or `null` to cancel. Cancelling an approval is a no. |
| `POST /v1/sessions/{id}/interrupt` | Stops the turn after the current step. |
| `POST /v1/sessions/{id}/mode` | `{ mode }` |
| `POST /v1/sessions/{id}/commands` | `{ command: "/status" }` runs a slash command and returns its output as `lines`. The output is not added to the conversation. |
| `DELETE /v1/sessions/{id}` | Closes the session. The conversation stays saved. |
| `GET /v1/sessions/{id}/events`, `GET /v1/events` | Server-Sent Events, for one session or for all of them. |

### MCP

`amness serve` also answers MCP (Streamable HTTP, `2026-07-28` and the earlier versions) at `/mcp`, with the same token. So Claude Code, Codex and other MCP clients can start and follow Amness sessions from another computer. See [Use Amness from Claude Code, Codex or another agent](mcp.md#use-amness-from-claude-code-codex-or-another-agent).

### Events

Each event has `type` and `session`:

| `type` | When |
|---|---|
| `item` | A transcript item is new or changed (a streamed answer changes many times; `item.id` stays the same). |
| `status` | `idle`, `running` or `waiting`. |
| `dialog`, `dialogClose` | A question or an approval opened or closed. |
| `turn.completed` | A turn ended: `text` is the answer, and `status` is `done` or `interrupted`. |
| `toast` | A short note (for example "rate limited, waiting"). |
| `closed` | The session ended. |

A browser's `EventSource` cannot send headers, so it may pass the token as `?t=<token>` on the events address.

## From Node: `AmnessClient`

```ts
import { AmnessClient } from "amness";

const c = new AmnessClient({ url: "http://127.0.0.1:4747", token: process.env.AMNESS_SERVE_TOKEN! });
const r = await c.run("fix the failing test, then run npm test", {
  mode: "acceptEdits",
  onDialog: (d) => (d.kind === "choice" && /npm test/.test(d.title ?? "") ? 0 : null),   // allow this one command, say no to anything else
});
console.log(r.finished, r.text);
```

`run` opens a session, sends the text, answers every question with `onDialog`, returns the answer and closes the session. For more control, use `create`, `send`, `events`, `answer`, `items`, `command`, `interrupt` and `close`.
