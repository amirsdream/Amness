# Safety and privacy

- **Data leaves your machine only to the provider you configure** (plus web search/fetch if you use the research agent). There is no telemetry. OpenAI requests are stateless by default (`store: false`).
- **Keys** come from environment variables or `~/.amness/config.json` (mode 600). They are never written into a project.
- **File tools are confined to the workspace** and enforce read-before-edit. **Shell commands are not sandboxed unless you turn the sandbox on** (`/sandbox workspace`, macOS and Linux with bubblewrap): otherwise `sh` can do whatever your user can, and the permission prompts and the safety floor are the safeguards, so read them, and prefer the sandbox, `plan` or `default` mode on code you do not trust.
- **Treat project-supplied context as untrusted.** Memory notes and `.amness/commands/` from a repository you cloned can contain prompt injection (so can `AGENTS.md`, which is loaded automatically). Notes are presented to the model as hints to verify, and risky actions still need your approval.
- The browser live view listens on `127.0.0.1` only, rejects foreign `Host` headers, and renders diffs as text, never HTML.
- `.amness/` holds per-project state (chats, checkpoints, handoffs, memory). Add it to your `.gitignore`, except `memory/` and `commands/` if you want to share those.
