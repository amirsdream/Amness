// OAuth 2.1 sign-in for remote MCP servers, as MCP 2026-07-28 "Authorization" describes it for a client:
// Protected Resource Metadata (RFC 9728) -> authorization server metadata (RFC 8414 / OpenID discovery, issuer checked) -> client id
// (configured, else Dynamic Client Registration, RFC 7591, application_type "native") -> authorization code with PKCE S256, `state`,
// and the `resource` parameter (RFC 8707) -> a loopback redirect -> `iss` checked (RFC 9207) -> tokens, refreshed when they expire.
// Client ID Metadata Documents need a public https URL for Amness's own metadata; Amness has none, so it uses the fallbacks.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type OAuthTokens = {
  access_token: string; refresh_token?: string; expires_at?: number; scope?: string;
  /** the authorization server that issued them; stored credentials are keyed by it */ issuer: string; token_endpoint: string;
  client_id: string; client_secret?: string; resource: string;
};
export type OAuthStore = { get: (key: string) => OAuthTokens | undefined; set: (key: string, t: OAuthTokens) => void; delete: (key: string) => void };
export type OAuthConfig = { clientId?: string; clientSecret?: string; scopes?: string; callbackPort?: number; authServerMetadataUrl?: string };

/** The canonical URI of an MCP server for the `resource` parameter: no fragment, no trailing slash (unless it is the whole path). */
export function canonicalResource(url: string): string {
  const u = new URL(url); u.hash = ""; u.search = "";
  let s = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}`; if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1); if (u.pathname === "/") s = s.slice(0, -1);
  return s;
}
const b64url = (b: Buffer) => b.toString("base64url");
const getJson = async (url: string): Promise<any | undefined> => { try { const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); return r.ok ? await r.json() : undefined; } catch { return undefined; } };
/** A parameter of a WWW-Authenticate Bearer challenge. */
export const challengeParam = (h: string | undefined, name: string) => h ? new RegExp(`${name}="([^"]*)"`, "i").exec(h)?.[1] ?? new RegExp(`${name}=([^,\\s]+)`, "i").exec(h)?.[1] : undefined;

/** Where the server says its authorization server is, and which scopes to ask for. */
export async function discoverAuth(serverUrl: string, o: { wwwAuthenticate?: string; authServerMetadataUrl?: string } = {}) {
  const u = new URL(serverUrl);
  let wa = o.wwwAuthenticate;
  if (!wa) { try { const r = await fetch(serverUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }), signal: AbortSignal.timeout(15_000) }); wa = r.headers.get("www-authenticate") ?? undefined; await r.body?.cancel(); } catch { /* use the well-known paths */ } }
  const prmUrls = [challengeParam(wa, "resource_metadata"), `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  let prm: any; for (const p of prmUrls) { prm = await getJson(p); if (prm?.authorization_servers?.length) break; }
  if (!prm?.authorization_servers?.length && !o.authServerMetadataUrl) throw new Error(`${serverUrl} does not say where to sign in (no OAuth protected resource metadata)`);
  let as: any;
  if (o.authServerMetadataUrl) { if (!o.authServerMetadataUrl.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(o.authServerMetadataUrl)) throw new Error("authServerMetadataUrl must use https"); as = await getJson(o.authServerMetadataUrl); }
  else {
    const issuer = String(prm.authorization_servers[0]), iu = new URL(issuer), path = iu.pathname === "/" ? "" : iu.pathname.replace(/\/$/, "");
    const cands = path ? [`${iu.origin}/.well-known/oauth-authorization-server${path}`, `${iu.origin}/.well-known/openid-configuration${path}`, `${iu.origin}${path}/.well-known/openid-configuration`] : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
    for (const c of cands) { const m = await getJson(c); if (m?.issuer) { if (m.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw new Error(`the sign-in server's metadata names another issuer (${m.issuer}, expected ${issuer})`); as = m; break; } }
  }
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error("the sign-in server's metadata is missing (authorization or token endpoint)");
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes("S256")) throw new Error("the sign-in server does not support PKCE S256");
  const scope = challengeParam(wa, "scope") ?? (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(" ") : undefined);
  return { as, resource: canonicalResource(prm?.resource ?? serverUrl), scope };
}

/** Sign in to a remote MCP server in the browser; saves and returns the tokens. `open` shows the address (a browser, or a printed link). */
export async function oauthLogin(serverUrl: string, o: { store: OAuthStore; open: (url: string) => void | Promise<void>; config?: OAuthConfig; wwwAuthenticate?: string; timeoutMs?: number }): Promise<OAuthTokens> {
  const cfg = o.config ?? {};
  const { as, resource, scope } = await discoverAuth(serverUrl, { wwwAuthenticate: o.wwwAuthenticate, authServerMetadataUrl: cfg.authServerMetadataUrl });
  // The loopback redirect (RFC 8252): a fixed port when configured (some pre-registered clients need it), else any free one.
  const verifier = b64url(randomBytes(32)), challenge = b64url(createHash("sha256").update(verifier).digest()), state = b64url(randomBytes(16));
  let resolveCode!: (v: { code: string; iss?: string }) => void, rejectCode!: (e: Error) => void;
  const got = new Promise<{ code: string; iss?: string }>((a, b) => { resolveCode = a; rejectCode = b; });
  got.catch(() => {});                                                                          // the answer can come while the browser step is still running; it is awaited below
  const srv = createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://127.0.0.1");
    if (q.pathname !== "/callback") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Amness</title><body style="font:16px system-ui;padding:3em">${q.searchParams.get("error") ? "Sign-in failed. You can close this window." : "Signed in. You can close this window and go back to Amness."}</body>`);
    if (q.searchParams.get("state") !== state) return rejectCode(new Error("the sign-in answer did not match (state)"));
    const iss = q.searchParams.get("iss") ?? undefined;
    if (iss !== undefined ? iss !== as.issuer : as.authorization_response_iss_parameter_supported === true) return rejectCode(new Error("the sign-in answer came from another issuer (iss)"));   // RFC 9207: checked before the code is used, errors too
    const err = q.searchParams.get("error"); if (err) return rejectCode(new Error(`sign-in refused: ${err}${q.searchParams.get("error_description") ? ` (${q.searchParams.get("error_description")})` : ""}`));
    const code = q.searchParams.get("code"); if (!code) return rejectCode(new Error("the sign-in answer has no code"));
    resolveCode({ code, iss });
  });
  await new Promise<void>((ok, fail) => { srv.once("error", fail); srv.listen(cfg.callbackPort ?? 0, "127.0.0.1", ok); });
  const redirect = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/callback`;
  try {
    let clientId = cfg.clientId, clientSecret = cfg.clientSecret;
    if (!clientId) {
      if (!as.registration_endpoint) throw new Error("the sign-in server has no client registration; set oauth.clientId for this server (amness mcp add … --client-id)");
      const r = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Amness", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" }), signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json().catch(() => ({})); if (!r.ok || !j.client_id) throw new Error(`client registration failed (HTTP ${r.status}${j.error ? `: ${j.error}` : ""})`);
      clientId = j.client_id; clientSecret = j.client_secret;
    }
    const scopes = cfg.scopes ?? scope, offline = Array.isArray(as.scopes_supported) && as.scopes_supported.includes("offline_access") && !(scopes ?? "").includes("offline_access");
    const a = new URL(as.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId!, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource, ...(scopes || offline ? { scope: [scopes, offline ? "offline_access" : ""].filter(Boolean).join(" ") } : {}) })) a.searchParams.set(k, v);
    await o.open(a.href);
    const t = setTimeout(() => rejectCode(new Error("no sign-in within the time limit")), o.timeoutMs ?? 5 * 60_000); t.unref?.();
    const { code } = await got.finally(() => clearTimeout(t));
    const tok = await tokenRequest(as.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId!, code_verifier: verifier, resource }, clientSecret);
    const saved: OAuthTokens = { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : undefined, scope: tok.scope, issuer: as.issuer, token_endpoint: as.token_endpoint, client_id: clientId!, client_secret: clientSecret, resource };
    o.store.set(resource, saved);
    return saved;
  } finally { srv.close(); }
}

async function tokenRequest(endpoint: string, form: Record<string, string>, secret?: string): Promise<any> {
  const body = new URLSearchParams({ ...form, ...(secret && { client_secret: secret }) });
  const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`the token request failed (HTTP ${r.status}${j.error ? `: ${j.error}${j.error_description ? ` – ${j.error_description}` : ""}` : ""})`);
  if (j.token_type && String(j.token_type).toLowerCase() !== "bearer") throw new Error(`unexpected token type ${j.token_type}`);
  return j;
}

/** The access token for a server, refreshed when it has (nearly) expired; undefined when you have not signed in or the refresh failed. */
export function oauthToken(serverUrl: string, store: OAuthStore): () => Promise<string | undefined> {
  return async () => {
    const key = canonicalResource(serverUrl), t = store.get(key); if (!t) return undefined;
    if (!t.expires_at || t.expires_at - Date.now() > 60_000) return t.access_token;
    if (!t.refresh_token) return t.access_token;                                                      // let the server say 401; then sign in again
    try {
      const j = await tokenRequest(t.token_endpoint, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id, resource: t.resource }, t.client_secret);
      const n: OAuthTokens = { ...t, access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined, scope: j.scope ?? t.scope };
      store.set(key, n); return n.access_token;
    } catch { return t.access_token; }
  };
}
