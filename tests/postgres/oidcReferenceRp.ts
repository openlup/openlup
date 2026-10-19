import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcTokens } from "./oidcIssuerFixture.js";
/** Small test RP: code/PKCE, state, nonce, HttpOnly session cookie and generation-fenced refresh. */
export async function createOidcReferenceRp() {
  type Session = { tokens: OidcTokens; issuer: string; client: string; generation: number };
  const pending = new Map<string, { issuer: string; client: string; verifier: string; nonce: string }>();
  const sessions = new Map<string, Session>();
  let origin = "";
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  const cookieName = "oidc_reference_session";
  const cookie = (id: string, end = false) => `${cookieName}=${id}; HttpOnly; SameSite=Lax; Path=/${end ? "; Max-Age=0" : ""}`;
  const tokenExchange = async (issuer: string, body: URLSearchParams) => fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(5000) });
  const end = (id: string) => { const session = sessions.get(id); if (session) { session.generation++; session.tokens = { access_token: "", refresh_token: "", id_token: "" }; } sessions.delete(id); };
  const server = createServer((req, res) => { void (async () => {
    if (req.headers.host !== new URL(origin).host) { res.writeHead(400).end(); return; }
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "POST" && url.pathname === "/logout" && req.headers.origin === origin) {
      const id = req.headers.cookie?.match(/(?:^|; )oidc_reference_session=([a-f0-9]+)/)?.[1]; if (id) end(id);
      res.writeHead(200, { "set-cookie": cookie("", true), "cache-control": "no-store" }).end("Session ended"); return;
    }
    if (req.method !== "GET" || url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const state = url.searchParams.get("state") ?? "", request = pending.get(state); pending.delete(state);
    assert(request && url.searchParams.get("code"), "RP callback state/code refused");
    const response = await tokenExchange(request.issuer, new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code")!, client_id: request.client,
      redirect_uri: `${origin}/callback`, code_verifier: request.verifier }));
    assert(response.ok, "RP code exchange refused");
    const tokens = await response.json() as OidcTokens;
    let keys = keySets.get(request.issuer);
    if (!keys) { keys = createRemoteJWKSet(new URL(`${request.issuer}/protocol/openid-connect/certs`)); keySets.set(request.issuer, keys); }
    const { payload } = await jwtVerify(tokens.id_token, keys, { issuer: request.issuer, audience: request.client, algorithms: ["RS256"] });
    assert.equal(payload.nonce, request.nonce, "RP nonce refused");
    assert(typeof tokens.access_token === "string" && typeof tokens.refresh_token === "string", "RP credentials unavailable");
    const id = randomBytes(32).toString("hex"); sessions.set(id, { tokens, issuer: request.issuer, client: request.client, generation: 0 });
    res.writeHead(200, { "set-cookie": cookie(id), "cache-control": "no-store" }).end("Authenticated");
  })().catch(() => { res.writeHead(400, { "cache-control": "no-store" }).end("Authentication refused"); }); });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`;
  return { origin, redirectUri: `${origin}/callback`, cookieName,
    loginUrl(issuer: string, client: string) {
      const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("hex"), nonce = randomBytes(32).toString("hex");
      pending.set(state, { issuer, client, verifier, nonce });
      const url = new URL(`${issuer}/protocol/openid-connect/auth`);
      url.search = new URLSearchParams({ client_id: client, redirect_uri: `${origin}/callback`, response_type: "code", scope: "openid email", state, nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString(); return url.href;
    },
    tokens(id: string) { return sessions.get(id)?.tokens ?? null; },
    async refresh(id: string, deliver: (response: Response) => Promise<Response> = async response => response) {
      const session = sessions.get(id); if (!session) return null;
      const generation = session.generation;
      const response = await deliver(await tokenExchange(session.issuer, new URLSearchParams({ grant_type: "refresh_token", client_id: session.client, refresh_token: session.tokens.refresh_token })));
      if (!response.ok) { end(id); return null; }
      const tokens = await response.json() as OidcTokens;
      if (sessions.get(id) !== session || session.generation !== generation) return null;
      session.tokens = tokens; return tokens;
    },
    async close() { pending.clear(); for (const id of sessions.keys()) end(id); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); },
  };
}
