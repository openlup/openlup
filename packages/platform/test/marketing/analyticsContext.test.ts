import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "../../src/bff/index.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { createAnalyticsContextHandler, type AnalyticsContextPersistencePort } from "../../src/marketing/server/index.js";

const cookieName = "__Host-context";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

function fixture() {
  const contexts = new Map<string, boolean>();
  const store = {
    syncContext: vi.fn(async (input: Parameters<AnalyticsContextPersistencePort["syncContext"]>[0]) => {
      if (!input.granted) { contexts.set(input.tokenHash, false); return false; }
      if (contexts.get(input.tokenHash) === false) return false;
      contexts.set(input.tokenHash, true);
      return true;
    }),
    enrollSubscriptions: vi.fn(async (_input: Parameters<AnalyticsContextPersistencePort["enrollSubscriptions"]>[0]) => true),
  };
  const deps = {
    respond: createBffResponder(),
    isEnabled: vi.fn(() => true),
    resolveStore: vi.fn((): AnalyticsContextPersistencePort | null => store),
    readAccessToken: vi.fn((req: HttpRequest) => {
      const header = req.headers.authorization;
      return header?.startsWith("Bearer ") ? header.slice(7) : null;
    }),
    resolveTrustedSubject: vi.fn(async (token: string) => token === "authenticated-token" ? "verified-subject" : null),
    capabilityCrypto: { mintToken: vi.fn(() => randomBytes(32).toString("hex")), hashToken: vi.fn(digest) },
    cookieName,
    clientIdField: "browserRef",
  };
  const handler = createAnalyticsContextHandler(deps);
  async function run(body: unknown, headers: Record<string, string> = {}) {
    const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
    res.status.mockReturnValue(res);
    await handler({ method: "POST", headers: { host: "shop.example", origin: "https://shop.example", ...headers },
      query: {}, body } as HttpRequest, res as unknown as HttpResponse);
    return res;
  }
  return { contexts, store, deps, run };
}

describe("first-party analytics consent capability", () => {
  it("refuses cross-origin mutation before reading the store", async () => {
    const { run, deps, store } = fixture();
    const res = await run({ granted: true, browserRef: "123.456" }, { origin: "https://other.example" });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: { code: "FORBIDDEN", message: "Same-origin request required" } });
    expect(deps.resolveStore).not.toHaveBeenCalled();
    expect(store.syncContext).not.toHaveBeenCalled();
    expect(deps.capabilityCrypto.mintToken).not.toHaveBeenCalled();
  });

  it("sets a secure opaque HttpOnly cookie, storing only its hash", async () => {
    const { run, deps, store, contexts } = fixture();
    const res = await run({ granted: true, browserRef: "123.456" });
    const token = deps.capabilityCrypto.mintToken.mock.results[0].value;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.setHeader).toHaveBeenCalledWith("Set-Cookie",
      `${cookieName}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
    expect(store.syncContext).toHaveBeenCalledExactlyOnceWith({ tokenHash: digest(token), granted: true, clientId: "123.456" });
    expect(contexts.has(token)).toBe(false);
    expect(contexts.get(digest(token))).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { active: true } });
  });

  it("withdraws the current context without disclosing an identity", async () => {
    const { run, deps, store, contexts } = fixture();
    const token = "a".repeat(64);
    const res = await run({ granted: false }, { cookie: `${cookieName}=${token}` });
    expect(store.syncContext).toHaveBeenCalledExactlyOnceWith({ tokenHash: digest(token), granted: false, clientId: null });
    expect(contexts.get(digest(token))).toBe(false);
    expect(deps.resolveTrustedSubject).not.toHaveBeenCalled();
    expect(store.enrollSubscriptions).not.toHaveBeenCalled();
    expect(deps.capabilityCrypto.mintToken).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { active: false } });
  });

  it("does not mint or persist a capability for denial without an existing cookie", async () => {
    const { run, deps, store } = fixture();
    const res = await run({ granted: false });
    expect(store.syncContext).not.toHaveBeenCalled();
    expect(store.enrollSubscriptions).not.toHaveBeenCalled();
    expect(deps.capabilityCrypto.mintToken).not.toHaveBeenCalled();
    expect(deps.readAccessToken).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { active: false } });
    // Only the responder adds no-store here; the handler's explicit header is after sync.
    expect(res.setHeader.mock.calls.filter(([key]) => key === "Cache-Control")).toEqual([["Cache-Control", "no-store"]]);
  });

  it("does not replace an active context during repeated preference saves", async () => {
    const { run, deps, store, contexts } = fixture();
    const token = "b".repeat(64);
    contexts.set(digest(token), true);
    const res = await run({ granted: true, browserRef: "123.456", explicitGrant: true }, { cookie: `${cookieName}=${token}` });
    expect(store.syncContext).toHaveBeenCalledExactlyOnceWith({ tokenHash: digest(token), granted: true, clientId: "123.456" });
    expect(deps.capabilityCrypto.mintToken).not.toHaveBeenCalled();
    expect(res.setHeader.mock.calls.some(([key]) => key === "Set-Cookie")).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { active: true } });
  });

  it("only an explicit new grant can replace a revoked context", async () => {
    const { run, deps, store, contexts } = fixture();
    const token = "b".repeat(64);
    contexts.set(digest(token), false);
    const res = await run({ granted: true, browserRef: "123.456" }, { cookie: `${cookieName}=${token}` });
    expect(store.syncContext).toHaveBeenCalledTimes(1);
    expect(deps.capabilityCrypto.mintToken).not.toHaveBeenCalled();
    expect(res.setHeader.mock.calls.some(([key]) => key === "Set-Cookie")).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { active: false } });

    store.syncContext.mockClear();
    const next = await run({ granted: true, browserRef: "123.456", explicitGrant: true }, { cookie: `${cookieName}=${token}` });
    const replacement = deps.capabilityCrypto.mintToken.mock.results[0].value;
    expect(store.syncContext.mock.calls).toEqual([
      [{ tokenHash: digest(token), granted: true, clientId: "123.456" }],
      [{ tokenHash: digest(replacement), granted: true, clientId: "123.456" }],
    ]);
    expect(contexts.get(digest(token))).toBe(false);
    expect(contexts.get(digest(replacement))).toBe(true);
    expect(next.setHeader).toHaveBeenCalledWith("Set-Cookie",
      `${cookieName}=${replacement}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  });

  it("enrolls only the server-verified subject and refuses an invalid bearer before writes", async () => {
    const { run, deps, store } = fixture();
    await run({ granted: true, browserRef: "123.456" }, { authorization: "Bearer authenticated-token" });
    expect(deps.resolveTrustedSubject).toHaveBeenCalledExactlyOnceWith("authenticated-token");
    expect(store.enrollSubscriptions).toHaveBeenCalledExactlyOnceWith({
      subject: "verified-subject", contextHash: store.syncContext.mock.calls[0][0].tokenHash,
    });
    expect(deps.resolveTrustedSubject.mock.invocationCallOrder[0]).toBeLessThan(store.syncContext.mock.invocationCallOrder[0]);
    expect(store.syncContext.mock.invocationCallOrder[0]).toBeLessThan(store.enrollSubscriptions.mock.invocationCallOrder[0]);

    store.syncContext.mockClear(); store.enrollSubscriptions.mockClear();
    const res = await run({ granted: true, browserRef: "123.456" }, { authorization: "Bearer invalid" });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: { code: "UNAUTHORIZED", message: "Customer session required" } });
    expect(store.syncContext).not.toHaveBeenCalled();
    expect(store.enrollSubscriptions).not.toHaveBeenCalled();
    expect(res.setHeader.mock.calls.some(([key]) => key === "Set-Cookie")).toBe(false);
  });

  it("is disabled before activation and accepts no contact or arbitrary tracking fields", async () => {
    const { run, deps, store } = fixture();
    const bad = await run({ granted: true, browserRef: "123.456", email: "not-accepted" });
    expect(bad.status).toHaveBeenCalledWith(400);
    expect(bad.json).toHaveBeenCalledWith({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid analytics context" } });
    expect(deps.resolveStore).not.toHaveBeenCalled();
    deps.isEnabled.mockReturnValue(false);
    const disabled = await run({ granted: false });
    expect(disabled.status).toHaveBeenCalledWith(404);
    expect(disabled.json).toHaveBeenCalledWith({ ok: false, error: { code: "NOT_FOUND", message: "Analytics context unavailable" } });
    expect(deps.resolveStore).not.toHaveBeenCalled();
    expect(store.syncContext).not.toHaveBeenCalled();
  });

  it("fails closed before minting when the injected persistence store is absent", async () => {
    const { run, deps, store } = fixture();
    deps.resolveStore.mockReturnValue(null);
    const res = await run({ granted: true, browserRef: "123.456" });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Analytics context unavailable" } });
    expect(deps.capabilityCrypto.mintToken).not.toHaveBeenCalled();
    expect(deps.readAccessToken).not.toHaveBeenCalled();
    expect(store.syncContext).not.toHaveBeenCalled();
    expect(store.enrollSubscriptions).not.toHaveBeenCalled();
  });
});
