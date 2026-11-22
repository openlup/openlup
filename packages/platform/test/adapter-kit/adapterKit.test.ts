import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createHardenedFetch,
  createOAuth2TokenManager,
  createRetryAfterCooldown,
  HardenedFetchError,
  OAuth2TokenError,
  parseRetryAfter,
  verifyEd25519Signature,
  verifyHardenedStandardWebhook,
  verifyHmacSha256,
} from "../../src/adapter-kit/index.js";

describe("@openlup/platform/adapter-kit", () => {
  it("pins HTTPS origins, enforces redirect: error, caps streaming bytes, and cancels non-2xx bodies", async () => {
    expect(() =>
      createHardenedFetch({ allowedOrigins: ["http://insecure.example"], fetchImpl: async () => new Response() }),
    ).toThrow(HardenedFetchError);
    expect(() =>
      createHardenedFetch({ allowedOrigins: ["https://api.example.test/with-path"], fetchImpl: async () => new Response() }),
    ).toThrow(HardenedFetchError);

    let seenRedirect: RequestRedirect | undefined;
    let bodyCancelled = false;
    const client = createHardenedFetch({
      allowedOrigins: ["https://api.example.test"],
      maxResponseBytes: 16,
      clock: () => 1_700_000_000_000,
      fetchImpl: async (url, init) => {
        seenRedirect = init?.redirect;
        const u = String(url);
        if (u.endsWith("/ok")) {
          return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
        }
        if (u.endsWith("/large")) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
              controller.enqueue(new Uint8Array(10));
              controller.close();
            },
          });
          return new Response(stream, { status: 200 });
        }
        const errStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("secret-upstream-body"));
            controller.close();
          },
          cancel() {
            bodyCancelled = true;
          },
        });
        return new Response(errStream, {
          status: 429,
          headers: { "retry-after": "45" },
        });
      },
    });

    const ok = await client.fetchJson<{ ok: number }>("https://api.example.test/ok");
    expect(ok.data).toEqual({ ok: 1 });
    expect(seenRedirect).toBe("error");

    await expect(client.fetchJson("https://evil.example.test/ok")).rejects.toMatchObject({
      kind: "origin_rejected",
      diagnosticCode: "ORIGIN_NOT_ALLOWED",
    });

    await expect(client.fetchBytes("https://api.example.test/large")).rejects.toMatchObject({
      kind: "body_too_large",
      diagnosticCode: "RESPONSE_BODY_TOO_LARGE",
    });

    try {
      await client.fetchJson("https://api.example.test/rate-limited");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HardenedFetchError);
      const err = error as HardenedFetchError;
      expect(err.kind).toBe("http_error");
      expect(err.status).toBe(429);
      expect(err.retryAfterSeconds).toBe(45);
      expect(err.message).not.toContain("secret-upstream-body");
      expect(bodyCancelled).toBe(true);
    }
  });

  it("parses integer and HTTP-date Retry-After headers and tracks cooldown via injected clock", () => {
    const baseMs = Date.UTC(2030, 0, 1, 0, 0, 0);
    expect(parseRetryAfter("120", baseMs)).toBe(120);
    expect(parseRetryAfter(new Date(baseMs + 30_000).toUTCString(), baseMs)).toBe(30);
    expect(parseRetryAfter("0", baseMs)).toBeUndefined();
    expect(parseRetryAfter("invalid", baseMs)).toBeUndefined();

    let now = baseMs;
    const cooldown = createRetryAfterCooldown({ clock: () => now });
    expect(cooldown.isCoolingDown()).toBe(false);
    expect(cooldown.recordRetryAfter("15")).toBe(15);
    expect(cooldown.isCoolingDown()).toBe(true);
    expect(cooldown.remainingSeconds()).toBe(15);
    now += 16_000;
    expect(cooldown.isCoolingDown()).toBe(false);
    expect(cooldown.remainingSeconds()).toBe(0);
  });

  it("deduplicates concurrent OAuth2 token requests, enforces refresh skew, guards invalidate epoch, and redacts secrets", async () => {
    let now = 1_700_000_000_000;
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secretCanary = "oauth-secret-canary-marker";

    const manager = createOAuth2TokenManager({
      tokenUrl: "https://auth.example.test/oauth2/token",
      grant: { type: "client_credentials", clientId: "cid-1", clientSecret: secretCanary, scope: "read" },
      clock: () => now,
      refreshSkewSeconds: 60,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) await firstGate;
        if (calls === 3) {
          return new Response(JSON.stringify({ error: `invalid ${secretCanary}` }), { status: 401 });
        }
        return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    // Single-flight deduplication
    const p1 = manager.getAccessToken();
    const p2 = manager.getAccessToken();
    releaseFirst();
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-1");
    expect(calls).toBe(1);

    // Cached hit before refresh skew
    now += 3_000_000;
    expect(await manager.getAccessToken()).toBe("tok-1");
    expect(calls).toBe(1);

    // Refresh skew triggers renewal
    now += 550_000;
    expect(await manager.getAccessToken()).toBe("tok-2");
    expect(calls).toBe(2);

    // Invalidate forces new fetch; 401 maps to auth_failed without leaking secret
    await manager.invalidate();
    try {
      await manager.getAccessToken();
      throw new Error("expected auth_failed");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuth2TokenError);
      expect((error as OAuth2TokenError).kind).toBe("auth_failed");
      expect((error as Error).message).not.toContain(secretCanary);
    }
  });

  it("verifies HMAC-SHA256 (hex/base64 + rotation), hardened Standard Webhooks, and Ed25519 signatures", () => {
    const body = '{"event":"order.paid"}';
    const hexSig = createHmac("sha256", "sec-new").update(body).digest("hex");
    expect(
      verifyHmacSha256({ payload: body, signature: `sha256=${hexSig}`, secrets: ["sec-old", "sec-new"], prefix: "sha256=" }),
    ).toBe(true);
    expect(
      verifyHmacSha256({ payload: body, signature: `sha256=${hexSig}`, secrets: ["sec-wrong"], prefix: "sha256=" }),
    ).toBe(false);

    const b64Sig = createHmac("sha256", "shopify-sec").update(body).digest("base64");
    expect(verifyHmacSha256({ payload: body, signature: b64Sig, secrets: ["shopify-sec"], encoding: "base64" })).toBe(true);

    // Standard Webhooks (whsec_ >= 16 bytes canonical base64)
    const rawKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    const whsec = `whsec_${rawKey.toString("base64")}`;
    const ts = "1700000100";
    const id = "msg_01";
    const expectedB64 = createHmac("sha256", rawKey).update(`${id}.${ts}.${body}`).digest("base64");
    expect(
      verifyHardenedStandardWebhook({
        rawBody: body,
        webhookId: id,
        timestamp: ts,
        signature: `v1,bad v1,${expectedB64}`,
        secrets: ["whsec_short", whsec],
        now: () => 1_700_000_200,
      }),
    ).toBe(true);
    // Rejects stale timestamp
    expect(
      verifyHardenedStandardWebhook({
        rawBody: body,
        webhookId: id,
        timestamp: ts,
        signature: `v1,${expectedB64}`,
        secrets: [whsec],
        now: () => 1_700_001_000,
      }),
    ).toBe(false);

    // Ed25519
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const edSig = cryptoSign(null, Buffer.from(body, "utf8"), privateKey).toString("base64");
    expect(verifyEd25519Signature({ payload: body, signature: edSig, publicKeyPem: pubPem })).toBe(true);
    expect(verifyEd25519Signature({ payload: `${body} `, signature: edSig, publicKeyPem: pubPem })).toBe(false);
    expect(verifyEd25519Signature({ payload: body, signature: "not-valid!", publicKeyPem: pubPem })).toBe(false);
    expect(
      verifyHardenedStandardWebhook({
        rawBody: body,
        webhookId: id,
        timestamp: ts,
        signature: `v1,${expectedB64}`,
        secrets: [whsec],
        now: () => Number.NaN,
      }),
    ).toBe(false);
  });

  it("prevents OAuth2 invalidate() cache races, isolates caller aborts, and validates per-request fetch bounds", async () => {
    const client = createHardenedFetch({
      allowedOrigins: ["https://api.example.test"],
      defaultHeaders: { Authorization: "Bearer default" },
      fetchImpl: async (_url, init) => {
        const hdrs = new Headers(init?.headers);
        return new Response(JSON.stringify({ auth: hdrs.get("authorization") }), { status: 200 });
      },
    });
    await expect(
      client.fetchBytes("https://api.example.test/ok", { maxResponseBytes: Number.NaN }),
    ).rejects.toMatchObject({ diagnosticCode: "INVALID_MAX_RESPONSE_BYTES" });
    await expect(
      client.fetchBytes("https://api.example.test/ok", { timeoutMs: 0 }),
    ).rejects.toMatchObject({ diagnosticCode: "INVALID_TIMEOUT_MS" });
    const overridden = await client.fetchJson<{ auth: string }>("https://api.example.test/ok", {
      headers: { authorization: "Bearer override" },
    });
    expect(overridden.data.auth).toBe("Bearer override");

    let releaseCache!: () => void;
    const cacheGate = new Promise<void>((r) => { releaseCache = r; });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((r) => { releaseFetch = r; });
    let cacheCleared = false;
    let fetchCalls = 0;
    const manager = createOAuth2TokenManager({
      tokenUrl: "https://auth.example.test/oauth2/token",
      grant: { type: "client_credentials", clientId: "cid", clientSecret: "sec-marker" },
      clock: () => 1_700_000_000_000,
      cache: {
        async get() {
          if (cacheCleared) return null;
          await cacheGate;
          return { accessToken: "stale-from-cache", expiresAtMs: 1_700_009_000_000 };
        },
        set() {},
        clear() {
          cacheCleared = true;
        },
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) await fetchGate;
        return new Response(JSON.stringify({ access_token: `fresh-${fetchCalls}`, expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    // invalidate() while cache.get() is pending must discard stale-from-cache
    const pendingToken = manager.getAccessToken();
    await manager.invalidate();
    releaseCache();
    await Promise.resolve();
    await Promise.resolve();
    // Meanwhile, Caller A aborts while Caller B awaits the same single-flight fetch
    const acA = new AbortController();
    const pA = manager.getAccessToken(acA.signal);
    acA.abort();
    await expect(pA).rejects.toMatchObject({ kind: "timeout" });
    releaseFetch();
    expect(await pendingToken).toBe("fresh-1");
    expect(fetchCalls).toBe(1);
  });
});
