# Development and limitations

```bash
npm install
npm run typecheck      # tsc --noEmit over src, cli, tests and examples
npm test               # unit and in-process UI tests (210+), run on Node's built-in test runner
npm run test:pty       # the real binary in a pseudo-terminal against a mock streaming server (needs python3)
```

The UI tests drive the real `App` with simulated keystrokes and read the screen back through a small VT100 emulator (`test/helpers/vterm.ts`), so layout, cursor placement and redraw behaviour are checked, not just strings. Model providers are exercised against scripted and mock HTTP servers, including one that reproduces OpenAI's "tools with reasoning" 400. Contributions are welcome: please keep `npm run typecheck` and `npm test` green.

## Limitations

- Developed and tested on macOS and Linux terminals; Windows is untested.
- Automated tests use scripted models and mock servers. Behaviour against live provider APIs has been checked by hand only, and provider APIs change; if one breaks, open an issue with the error text.
- Cost figures are estimates (no invoices, cached input assumed at about 10% of the input price, and some models have no price listed).
- Newer features (cache keep-alive, semantic memory, `amness eval` against a real model) are covered by tests with scripted models and mock servers, but have not been run against live provider APIs. The efficiency numbers quoted from papers are theirs, not measurements of Amness.
- Semantic memory sends note text and your messages to your provider's embeddings endpoint, and needs an OpenAI-compatible provider (Claude has none).
- Gaps compared with other harnesses (hooks, OS sandbox, skills, custom subagents, background processes and more) are tracked in [ROADMAP.md](../ROADMAP.md), together with a second track of ideas for getting ahead of them (grounded verification, trace replay, cache-aware routing, taint-based security, bounded self-improvement).
- Not on npm yet (see above), and the Docker image is untested.
- Tool-calling quality with small local models varies widely.
