// A fake OAuth 2.1 authorization server and a protected MCP endpoint (modern, stateless) on one port, for sign-in tests.
// It checks what MCP 2026-07-28 requires of a client: PKCE S256, the resource parameter, the registered redirect; it sends iss back.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function fakeOAuth(o: { badIss?: boolean } = {}) {
  const codes = new Map<string, { challenge: string; resource: string; redirect: string }>(), valid = new Set<string>(); let n = 0;
  const seen: { tokenForms: Record<string, string>[]; authorize: Record<string, string>[] } = { tokenForms: [], authorize: [] };
  const srv = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, u = new URL(req.url ?? "/", base);
    const body = await new Promise<string>((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
    const json = (code: number, j: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(j)); };
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/as`], scopes_supported: ["read"] });
    if (u.pathname === "/.well-known/oauth-authorization-server/as") return json(200, { issuer: `${base}/as`, authorization_endpoint: `${base}/as/authorize`, token_endpoint: `${base}/as/token`, registration_endpoint: `${base}/as/register`, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true, scopes_supported: ["read", "offline_access"] });
    if (u.pathname === "/as/register") { const j = JSON.parse(body); if (j.application_type !== "native") return json(400, { error: "invalid_client_metadata" }); return json(201, { client_id: "c1", redirect_uris: j.redirect_uris }); }
    if (u.pathname === "/as/authorize") {
      const q = Object.fromEntries(u.searchParams); seen.authorize.push(q);
      if (q.code_challenge_method !== "S256" || !q.code_challenge || q.resource !== `${base}/mcp` || q.client_id !== "c1") return json(400, { error: "invalid_request" });
      const code = `code${++n}`; codes.set(code, { challenge: q.code_challenge, resource: q.resource, redirect: q.redirect_uri });
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}&iss=${encodeURIComponent(o.badIss ? "https://evil.example" : `${base}/as`)}` }); return res.end();
    }
    if (u.pathname === "/as/token") {
      const f = Object.fromEntries(new URLSearchParams(body)); seen.tokenForms.push(f);
      if (f.grant_type === "authorization_code") {
        const c = codes.get(f.code); if (!c) return json(400, { error: "invalid_grant" });
        if (createHash("sha256").update(f.code_verifier).digest("base64url") !== c.challenge || f.resource !== c.resource || f.redirect_uri !== c.redirect) return json(400, { error: "invalid_grant" });
        codes.delete(f.code); valid.add("at1"); return json(200, { access_token: "at1", token_type: "Bearer", expires_in: 1, refresh_token: "rt1", scope: "read" });
      }
      if (f.grant_type === "refresh_token" && f.refresh_token === "rt1") { valid.add("at2"); return json(200, { access_token: "at2", token_type: "Bearer", expires_in: 3600 }); }
      return json(400, { error: "invalid_grant" });
    }
    if (u.pathname === "/mcp") {
      const tok = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (!tok || !valid.has(tok)) { res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"` }); return res.end(); }
      const m = JSON.parse(body);
      const result = m.method === "server/discover" ? { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
        : m.method === "tools/list" ? { resultType: "complete", tools: [{ name: "whoami", description: "Who am I", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], ttlMs: 1000, cacheScope: "private" }
        : m.method === "tools/call" ? { resultType: "complete", content: [{ type: "text", text: `token ${tok}` }] } : undefined;
      return result ? json(200, { jsonrpc: "2.0", id: m.id, result }) : json(404, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    }
    json(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url: `${base}/mcp`, base, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
/** Plays the browser: follows the authorization redirect to the loopback callback. */
export const browser = async (url: string) => { const r = await fetch(url, { redirect: "manual" }); const loc = r.headers.get("location"); if (!loc) throw new Error(`no redirect (${r.status} ${await r.text()})`); await (await fetch(loc)).text(); };
