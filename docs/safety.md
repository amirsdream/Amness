# Safety and privacy

This page tells you what data leaves your machine, what stops the agent from doing harm, and what does not protect you.

In this page you will learn:

- which servers receive your data, and what you send them
- what the agent can and cannot do on your computer
- how to make Amness stricter, with exact commands
- which risks Amness does not cover

Amness is a terminal coding agent. A *model provider* is the company or server that runs the AI model, for example OpenAI or Anthropic. A *shell command* is a line of text that the agent runs in your terminal, such as `npm test`.

## Check what leaves your machine

**What it is.** Amness sends text to the model provider you choose. It sends nothing to Amness servers. The code has no telemetry. The code makes no request to any other host than the ones in the table below (checked in `src/openai.ts`, `src/anthropic.ts`, `src/web.ts`, `src/embed.ts`, `src/trace.ts` and `src/dynamic.ts`).

**Why it matters.** Anything the model reads, the provider receives. This includes the files the agent reads and the output of commands it runs.

| What is sent | Where it goes | When |
|---|---|---|
| Your messages, tool results, file contents the agent reads, command output, memory notes, `AGENTS.md` text | The provider you configure (`https://api.openai.com/v1`, `https://api.anthropic.com`, OpenRouter, or your own `baseUrl`) | Every model request |
| Pictures you attach with `@file` | The same provider | Only when you attach them |
| Note text and your messages, to build search vectors | The `/embeddings` endpoint of your OpenAI-compatible provider | Only when `/memory embeddings on` is set. It is off by default. Claude has no such endpoint |
| Search queries | `https://api.tavily.com` if `TAVILY_API_KEY` is set, otherwise `https://html.duckduckgo.com` | Only in the research agent (`createDeepAgent`) |
| Page requests | The web page you or the research agent fetch (`fetch_url`). It refuses local and private addresses | Only in the research agent |
| A trace of loop events | The URL in `AMNESS_OTLP` | Only when you set that variable. Secrets are masked first |
| A second model call that reads a risky command | The same provider (or the model you name) | Only when `approvalReviewer` is on |
| Tool calls and tool results | An MCP server you start with `/mcp <command>`. It runs on your machine as a child process | Only when you attach one. The server can contact other hosts. Amness cannot see that |

Notes about the provider:

- OpenAI requests use `store: false` by default. This means OpenAI is asked not to keep the response. Amness replays the encrypted reasoning itself. You can turn this off with the `store` option in the library. This is the setting in the code. Amness cannot check what the provider really does.
- With `--provider ollama` or another local server, requests go to `http://localhost:11434/v1` or the `baseUrl` you set. Nothing leaves your machine unless that server forwards it.

## Know where your keys are stored

- Keys come from the environment variables `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, or from `~/.amness/config.json`. Amness writes that file with mode 600. Only your user can read it.
- The environment variable wins over the saved key.
- Amness does not write keys into a project folder.
- Commands the agent runs do not get your Amness keys. The variables `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `OPENROUTER_API_KEY` and `AMNESS_OTLP` are removed from their environment (`childEnv` in `src/secrets.ts`).
- Hooks run with an even smaller environment. Any variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` or `AUTH` is removed (`scrubbedEnv` in `src/hooks.ts`).
- An MCP server gets your full environment (`loadMcp` passes `process.env`). Pass `env` and review what you start.

## See what the agent can and cannot do

| The agent can | The agent cannot (tested in `test/permissions.test.ts`, `test/sandbox.test.ts`, `test/taint.test.ts`, `test/secrets.test.ts`) |
|---|---|
| Read and edit files inside the workspace, after it has read them | Edit a file outside the workspace with its file tools (`path escapes the workspace`) |
| Run shell commands you approve, or that a rule allows | Run `rm -rf /`, `rm -rf ~`, `mkfs`, a fork bomb, or force-push to `main` or `master`. This is the *floor*. The floor holds in every mode, also `yolo` |
| Run read-only commands such as `ls`, `cat`, `git status` without asking | Edit `.git` files with file tools |
| Start background processes with `sh_start` | Edit `.amness/hooks.json` or `.amness/permissions.json`, with file tools or with shell commands |
| Use tools from an MCP server you attached | Skip your `deny` rules |
| | Run a command that contains text copied from a web page or MCP tool result, without you approving it (the *taint check*) |
| | Show you a raw secret in tool output that matches a known pattern (it is masked) |

### How a request is judged

Each tool call passes through these layers, in this order. The first layer that decides, wins.

1. The *floor*: built-in refusals and built-in questions.
2. Your `deny` rules.
3. The *taint check*: a shell command that copies three or more words (or one very long word) from untrusted tool output needs your approval.
4. Your `ask` rules.
5. Your `allow` rules.
6. The permission mode: `default`, `acceptEdits`, `plan` or `yolo`.

Some commands always ask, even in `yolo`: `curl ... | sh`, `git push --force`, and commands that decode a payload and run it.

### What the floor does not stop

The floor and the risk list match patterns in the command text. Amness also decodes simple tricks such as `r""m`, `$'\x72m'` and `sh -c '...'`. A new trick can still get past a pattern. Treat the floor as a safety net, not as a guarantee.

### Secret masking

Before the model sees a tool result, Amness replaces known secret formats with `[REDACTED:<kind>]`. It knows keys from Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe and npm, private keys, JWT tokens, `Bearer` tokens, and assignments such as `PASSWORD=...`. The same masking is applied to trace files.

Masking has limits:

- It only applies to tool results. It does not touch what you type.
- It finds patterns. A secret in a format it does not know passes through.
- Masking is not applied to memory notes or `AGENTS.md` text (not verified in the memory code).

## Make Amness stricter

### Turn on the sandbox

**What it is.** The *sandbox* is a feature of your operating system that limits what a program can do. On macOS Amness uses Seatbelt (`sandbox-exec`). On Linux it uses Bubblewrap (`bwrap`).

**Why you would use it.** Permission prompts are a policy. The sandbox is enforcement. Even an approved command cannot write outside the project.

**How to use it.**

1. On Linux, install Bubblewrap: `sudo apt install bubblewrap`.
2. In the chat, run one of these:

```text
/sandbox workspace
/sandbox strict
```

3. For a headless run, add the flag:

```bash
amness run --sandbox strict "list the TODO comments"
```

4. To keep it for every session, put it in `~/.amness/config.json`:

```json
{ "sandbox": "strict" }
```

**Example.** With `/sandbox strict` on, ask the agent to run `curl https://example.com`. The command fails because the network is cut. Run `/sandbox` with no argument to see the current mode.

| Mode | Writes allowed in | `.git` | Network | Your credential-looking variables |
|---|---|---|---|---|
| `off` | everywhere your user can write | writable | yes | passed on (except Amness keys) |
| `workspace` | the project, temp folders, package caches | read-only | yes | removed from the environment |
| `strict` | the project and temp folders | read-only | no | removed from the environment |

**Limits and common problems.**

- Reads are not limited. A sandboxed command can still read `~/.ssh` or any file your user can read (tested in `test/sandbox.test.ts`). In `workspace` mode it can also send data over the network.
- The sandbox covers shell commands and background processes. It does not cover the file tools (they have their own workspace check), hooks, plugins, or MCP servers.
- There is no Windows sandbox. On Windows, asking for a sandbox gives an error.
- If the sandbox is on but cannot start, Amness refuses to run the command. It never runs it unprotected without telling you. Use `/sandbox off` to turn it off on purpose.
- `strict` stops `npm install` and anything else that needs the network.
- On some Linux systems and containers, Bubblewrap is installed but the kernel does not allow it. Amness tests this when it starts.

### Add permission rules

**What it is.** A rule says "allow", "ask" or "deny" for a tool. The syntax is `tool(pattern)`. Tools are `sh`, `edit` and `read`. In a `sh` pattern, `*` matches anything. In a path pattern, `*` stays inside one folder and `**` crosses folders.

**How to use it.**

1. Add a rule in the chat:

```text
/permissions deny sh(git push*)
/permissions deny edit(.env)
/permissions ask sh(git commit*)
```

2. Or write the file `.amness/permissions.json` (project) or `~/.amness/permissions.json` (all projects):

```json
{
  "allow": ["sh(npm test*)", "edit(src/**)"],
  "ask": ["sh(git commit*)"],
  "deny": ["sh(git push*)", "edit(.env)"]
}
```

3. Run `/permissions` to list the rules in effect.

**Example.** After the `deny` rule above, a call to `git push origin dev` is refused. The agent sees `DENIED: denied by your permission rule` and must choose another way.

**Limits and common problems.**

- `/permissions` writes to the project file. For a rule that applies to every project, edit `~/.amness/permissions.json` yourself.
- A compound command such as `npm test && git push` is split into parts. Each part is checked. A command with a subshell or backticks cannot be split, so an `allow` rule never matches it. A `deny` or `ask` rule still can.
- Project `deny` and `ask` rules always apply. Project `allow` rules apply only after you approve the project (see below).
- A rule file with a wrong format stops loading and Amness shows a message.

### Choose a safer permission mode

Press `Shift+Tab` or run `/mode`.

| Mode | Behaviour |
|---|---|
| `plan` | Read-only. The agent investigates and shows a plan |
| `default` | Asks before edits and before shell commands that are not read-only |
| `acceptEdits` | Edits apply automatically. Shell commands still ask |
| `yolo` | No questions for ordinary edits and commands. The floor still applies. The shell is not sandboxed unless you turned the sandbox on. Use it in a container or a throwaway checkout |

Headless runs (`amness run`) deny risky commands unless you pass `--yes`. Do not use `--yes` on code you do not trust.

### Approve project files on purpose

A cloned repository can contain `.amness/hooks.json`, `.amness/plugins/` and `allow` rules. These run code or remove prompts. Amness does not use them until you approve the exact files.

1. In the chat, Amness asks once for hooks and rules, and once for plugins. Read the files first.
2. If a file changes later, Amness asks again. The check compares a fingerprint of the exact content.
3. In a headless run, project hooks, plugins and `allow` rules are off. Pass `--trust-project` to use them.

Hooks and plugins are not sandboxed. A trusted hook can do anything your user can do.

### Reduce what is sent

- Use a local model: choose Ollama with `/provider` in the chat, or run `amness run --provider ollama --model qwen2.5-coder:7b "task"`.
- Keep semantic memory off: `/memory embeddings off`.
- Disable memory for one run: `amness run --no-memory "task"`.
- Do not set `AMNESS_OTLP` and do not pass `--trace` when you do not need them. A trace file is written locally in `--trace <file>`.
- Do not attach an MCP server you do not trust.

### Handle untrusted text

Treat context from a repository you cloned as untrusted. Memory notes, `.amness/commands/` and `AGENTS.md` can contain *prompt injection*. This is text that tries to give the model new orders.

What Amness does:

- It wraps output of `web_search`, `fetch_url` and MCP tools with a warning that this is data, not instructions.
- It asks you before a shell command that copies text from that output (the taint check). In the library you can set `taint: "deny"` to refuse, or `"off"` to ignore. The chat and `amness run` use the default, `"ask"`. There is no command-line flag for this.
- It presents memory notes as hints to verify.

## Know what is NOT protected

- **Shell commands without the sandbox.** The agent can do what your user can do. The prompts and the floor are the only protection.
- **Reads.** Even with the sandbox, commands can read any file your user can read.
- **The network in `workspace` mode.** A command can send data away.
- **The model provider.** Amness cannot check what a provider stores or logs.
- **Symbolic links.** The file-tool workspace check compares path text. The code does not resolve symbolic links, and no test covers it. A link inside the project that points outside may pass. Not verified.
- **Hooks, plugins and MCP servers.** They run as programs on your machine with your permissions. The sandbox does not cover them.
- **Secrets in formats Amness does not know.** They are not masked.
- **A command you approve.** If you press yes, it runs. Read the command first.
- **Windows.** There is no sandbox. The Windows test job in CI is informational only.
- **Project state.** `.amness/` holds chats, checkpoints, handoffs and memory. These can contain the text of your code and commands. Add `.amness/` to your `.gitignore`. Keep `memory/` and `commands/` only if you want to share them.
- **The browser live view** (`--live`) listens on `127.0.0.1` only, rejects foreign `Host` headers, and shows diffs as text, never as HTML. Anyone who can use your machine can still open it.

## Related pages

- [Using the chat](usage.md) for permission modes and slash commands
- [Features in depth](features.md) for hooks, the sandbox and permissions
- [Plugins](plugins.md) for code that changes the agent
- [Headless and CI](headless.md) for `--yes`, `--sandbox` and `--trust-project`
- [Providers and models](providers.md) for local models

## Next steps

- Try the sandbox: [Using the chat](usage.md)
- Run Amness safely in CI: [Headless and CI](headless.md)
- Read how the loop guards work: [Why: what Amness checks](why.md)

## Which shell runs the agent's commands

Amness checks what exists on your machine. On macOS and Linux it uses `bash`, then `zsh`, then `sh`. On Windows it uses the bash that comes with Git for Windows, then PowerShell 7 (`pwsh`), then Windows PowerShell, then `cmd.exe`. The model is told which shell it has, so it writes PowerShell commands for PowerShell. Use `/shell` to see the choice and change it, or set `AMNESS_SHELL`. The safety floor blocks the same kinds of damage in each family, for example `rm -rf /` in bash and `Remove-Item -Recurse -Force C:\` in PowerShell, and it asks before `iwr ... | iex` or an encoded command. The permission rules you write are matched as text, so write them for the shell you use. The OS sandbox exists only for bash-style shells on macOS and Linux; it is not available on Windows.
