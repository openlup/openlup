/**
 * Ported from the edge `unsubscribe` handler suite. The cases are the
 * Edge function's cases on purpose: this route only earns the right to replace
 * that function if it answers every request shape the same way, including the
 * legacy tester links that carry no token and never expire.
 */
import { describe, expect, it, vi } from "vitest";
import {
  UNSUBSCRIBE_LINK_TTL_SECONDS,
  buildUnsubscribeToken,
} from "../src/domains/communications/unsubscribeToken.js";
import {
  createUnsubscribeRouteHandler,
  htmlPage,
  type UnsubscribeClient,
} from "./unsubscribe.js";

// Derive the request/response shapes from the route itself rather than importing
// the platform types. The suite then names no hosting platform, and it still
// fails to compile if the route's own signature drifts.
type RouteHandler = ReturnType<typeof createUnsubscribeRouteHandler>;
type Req = Parameters<RouteHandler>[0];
type Res = Parameters<RouteHandler>[1];

const TOKEN_SECRET = ["route-test", "unsubscribe-secret", "0123456789"].join("-");

interface Captured {
  res: Res;
  status: () => number | null;
  body: () => string;
  json: () => unknown;
  headers: () => Record<string, string>;
}

function capture(): Captured {
  let statusCode: number | null = null;
  let body = "";
  let jsonBody: unknown = null;
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key.toLowerCase()] = value;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    send: vi.fn((value: string) => {
      body = String(value);
      return res;
    }),
    json: vi.fn((value: unknown) => {
      jsonBody = value;
      return res;
    }),
    end: vi.fn(() => res),
  } as unknown as Res;
  return {
    res,
    status: () => statusCode,
    body: () => body,
    json: () => jsonBody,
    headers: () => headers,
  };
}

function request(method: string, url: string, query?: Record<string, string>): Req {
  return { method, url, query } as unknown as Req;
}

function get(url: string, query?: Record<string, string>): Req {
  return request("GET", url, query);
}

function successfulRpc(status: "applied" | "already_suppressed" = "applied") {
  return vi.fn(async (_name: string, params: Record<string, unknown>) => {
    const purposeCount = Array.isArray(params.p_purposes) ? params.p_purposes.length : 0;
    return {
      data: {
        status,
        durablySuppressed: true,
        requestedPurposeCount: purposeCount,
        suppressedPurposeCount: purposeCount,
      },
    };
  });
}

function legacyClient({
  rpc = successfulRpc(),
  tester = { id: "tester-1", email: "jan@example.com" },
  lookupError,
}: {
  rpc?: ReturnType<typeof vi.fn>;
  tester?: { id: string; email: string } | null;
  lookupError?: unknown;
} = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: tester, error: lookupError });
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle }),
        }),
      }),
    }),
    rpc,
  } as unknown as UnsubscribeClient;
  return { client, maybeSingle, rpc };
}

function tokenOnlyClient(rpc?: ReturnType<typeof vi.fn>): UnsubscribeClient {
  return (rpc ? { rpc } : {}) as unknown as UnsubscribeClient;
}

function signedMarketingToken(email = "owner@example.com"): Promise<string> {
  return buildUnsubscribeToken({ email, purpose: "marketing_newsletter" }, TOKEN_SECRET);
}

/**
 * Mint the pre-expiry payload shape by hand. Every unsubscribe link already
 * delivered carries `{e, p, v}` and no `exp`, and the route must keep answering
 * those; the builder can no longer produce one, so the suite signs it directly.
 */
async function legacyTokenWithoutExp(email = "owner@example.com"): Promise<string> {
  const toBase64url = (value: string) =>
    btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = toBase64url(JSON.stringify({ e: email, p: "marketing_newsletter", v: 1 }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${body}.${toBase64url(binary)}`;
}

function tokenUrl(token: string, extra = ""): string {
  return `/api/unsubscribe?${extra}token=${encodeURIComponent(token)}`;
}

describe("unsubscribe route - transport", () => {
  it("refuses methods other than GET", async () => {
    const route = createUnsubscribeRouteHandler({ createClient: vi.fn() as never });
    const out = capture();

    await route(request("POST", "/api/unsubscribe"), out.res);

    expect(out.status()).toBe(405);
    expect(out.json()).toEqual({ error: "method not allowed" });
    expect(out.headers().allow).toBe("GET");
  });

  it("never leaks the token through the referrer or a cache", async () => {
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(successfulRpc()),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();

    await route(get(tokenUrl(await signedMarketingToken())), out.res);

    const headers = out.headers();
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(headers["x-email-presentation"]).toBeTruthy();
  });

  it("reads the parameters the platform already parsed onto the request", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();
    const token = await signedMarketingToken();

    // No query string on `req.url` — only the parsed `req.query`.
    await route(get("/api/unsubscribe", { token, lang: "en" }), out.res);

    expect(out.status()).toBe(200);
    expect(out.body()).toContain("You're unsubscribed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("unsubscribe route - legacy tester link", () => {
  it("returns 400 when query params are missing", async () => {
    const route = createUnsubscribeRouteHandler({ createClient: vi.fn() as never });
    const out = capture();

    await route(get("/api/unsubscribe"), out.res);

    expect(out.status()).toBe(400);
    expect(out.body()).toContain("Brakuje danych");
  });

  it("returns 404 when tester is not found", async () => {
    const { client, rpc } = legacyClient({ tester: null });
    const route = createUnsubscribeRouteHandler({ createClient: () => client });
    const out = capture();

    await route(get("/api/unsubscribe?id=tester-1&email=jan@example.com"), out.res);

    expect(out.status()).toBe(404);
    expect(out.body()).toContain("Nie znaleziono");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 500 when the legacy tester lookup fails", async () => {
    const { client, rpc } = legacyClient({ lookupError: { message: "db unavailable" } });
    const route = createUnsubscribeRouteHandler({ createClient: () => client });
    const out = capture();

    await route(get("/api/unsubscribe?id=tester-1&email=jan@example.com"), out.res);

    expect(out.status()).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("suppresses all legacy purposes in one RPC", async () => {
    const { client, rpc } = legacyClient();
    const route = createUnsubscribeRouteHandler({ createClient: () => client });
    const out = capture();

    await route(get("/api/unsubscribe?id=tester-1&email=jan@example.com"), out.res);

    expect(out.status()).toBe(200);
    expect(out.body()).toContain("Wypisano");
    expect(out.body()).toContain("wiadomosci marketingowych i dla testerow");
    expect(out.body()).toContain("obslugi konta, zamowien, platnosci i subskrypcji");
    expect(out.body()).not.toContain("wiadomosci transakcyjne");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("communication_apply_unsubscribe", expect.objectContaining({
      p_email: "jan@example.com",
      p_purposes: ["tester_program", "marketing_launch_offer", "marketing_newsletter"],
      p_source_table: "testers",
      p_source_id: "tester-1",
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_captured_at");
  });

  it("renders already-suppressed copy for an idempotent legacy replay", async () => {
    const { client } = legacyClient({ rpc: successfulRpc("already_suppressed") });
    const route = createUnsubscribeRouteHandler({ createClient: () => client });
    const out = capture();

    await route(get("/api/unsubscribe?id=tester-1&email=jan@example.com"), out.res);

    expect(out.status()).toBe(200);
    expect(out.body()).toContain("Juz wypisany/a");
    expect(out.body()).toContain("wiadomosci marketingowych i dla testerow");
    expect(out.body()).not.toContain("wiadomosci transakcyjne");
  });

  it("narrows to a single purpose when the link names one", async () => {
    const { client, rpc } = legacyClient();
    const route = createUnsubscribeRouteHandler({ createClient: () => client });
    const out = capture();

    await route(
      get("/api/unsubscribe?id=tester-1&email=jan@example.com&purpose=marketing_newsletter"),
      out.res,
    );

    expect(out.status()).toBe(200);
    expect(rpc).toHaveBeenCalledWith("communication_apply_unsubscribe", expect.objectContaining({
      p_purposes: ["marketing_newsletter"],
    }));
  });

  it("returns 500 when the atomic legacy write fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "update failed" } });
    const { client } = legacyClient({ rpc });
    const route = createUnsubscribeRouteHandler({ createClient: () => client });
    const out = capture();

    await route(get("/api/unsubscribe?id=tester-1&email=jan@example.com"), out.res);

    expect(out.status()).toBe(500);
  });

  it("renders the html helper with the supplied title and message", () => {
    expect(htmlPage("Title", "Body")).toContain("<h1>Title</h1>");
    expect(htmlPage("Title", "Body")).toContain("<p>Body</p>");
  });
});

describe("unsubscribe route - signed token", () => {
  it("confirms suppression only after a durable RPC result", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();

    await route(get(tokenUrl(await signedMarketingToken())), out.res);

    expect(out.status()).toBe(200);
    expect(out.body()).toContain("Wypisano");
    expect(rpc).toHaveBeenCalledWith("communication_apply_unsubscribe", expect.objectContaining({
      p_email: "owner@example.com",
      p_purposes: ["marketing_newsletter"],
      p_source_table: null,
      p_source_id: null,
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_captured_at");
  });

  it("stays idempotent: a replayed link confirms again without a new outcome", async () => {
    const rpc = successfulRpc("already_suppressed");
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();

    await route(get(tokenUrl(await signedMarketingToken())), out.res);

    expect(out.status()).toBe(200);
    expect(out.body()).toContain("Wypisano");
  });

  it("returns English copy with lang=en", async () => {
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(successfulRpc()),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();

    await route(get(tokenUrl(await signedMarketingToken("a@b.com"), "lang=en&")), out.res);

    expect(out.body()).toContain("You're unsubscribed");
  });

  it.each([
    ["missing rpc", undefined],
    ["rpc error", vi.fn().mockResolvedValue({ data: null, error: { message: "db" } })],
    ["thrown rpc", vi.fn().mockRejectedValue(new Error("network"))],
    ["malformed rpc result", vi.fn().mockResolvedValue({ data: { status: "applied" } })],
    ["superseded historical result", vi.fn().mockResolvedValue({
      data: {
        status: "superseded",
        durablySuppressed: false,
        requestedPurposeCount: 1,
        suppressedPurposeCount: 0,
      },
    })],
  ])("returns 500 for %s", async (_label, rpc) => {
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc as ReturnType<typeof vi.fn> | undefined),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();

    await route(get(tokenUrl(await signedMarketingToken())), out.res);

    expect(out.status()).toBe(500);
  });

  it("rejects an invalid token without touching the client", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();

    await route(get("/api/unsubscribe?token=garbage.sig"), out.res);

    expect(out.status()).toBe(400);
    expect(out.body()).toContain("Link nieprawidlowy lub wygasl");
    expect(rpc).not.toHaveBeenCalled();
  });

  // A token minted today expires; a token minted before `exp` existed does not.
  // Both land on the route's existing "invalid or expired" page, so an expired
  // link reads correctly to the recipient without any new copy.
  it("refuses an expired token and writes nothing", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();
    const stale = await buildUnsubscribeToken(
      { email: "owner@example.com", purpose: "marketing_newsletter" },
      TOKEN_SECRET,
      { now: new Date(Date.now() - (UNSUBSCRIBE_LINK_TTL_SECONDS + 60) * 1000) },
    );

    await route(get(tokenUrl(stale)), out.res);

    expect(out.status()).toBe(400);
    expect(out.body()).toContain("Link nieprawidlowy lub wygasl");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still honours a legacy token minted without an exp claim", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();

    await route(get(tokenUrl(await legacyTokenWithoutExp())), out.res);

    expect(out.status()).toBe(200);
    expect(out.body()).toContain("Wypisano");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses to suppress a transactional purpose", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();
    const token = await buildUnsubscribeToken(
      { email: "a@b.com", purpose: "transactional" },
      TOKEN_SECRET,
    );

    await route(get(tokenUrl(token)), out.res);

    expect(out.status()).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a signed but unknown marketing purpose", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();
    const token = await buildUnsubscribeToken(
      { email: "a@b.com", purpose: "marketing_unknown" },
      TOKEN_SECRET,
    );

    await route(get(tokenUrl(token)), out.res);

    expect(out.status()).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a token when no secret is configured", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({ createClient: () => tokenOnlyClient(rpc) });
    const out = capture();

    await route(get(tokenUrl(await signedMarketingToken("a@b.com"))), out.res);

    expect(out.status()).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a token signed with a different secret", async () => {
    const rpc = successfulRpc();
    const route = createUnsubscribeRouteHandler({
      createClient: () => tokenOnlyClient(rpc),
      tokenSecret: TOKEN_SECRET,
    });
    const out = capture();
    const foreign = await buildUnsubscribeToken(
      { email: "a@b.com", purpose: "marketing_newsletter" },
      "a-different-unsubscribe-secret-9876543210",
    );

    await route(get(tokenUrl(foreign)), out.res);

    expect(out.status()).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("unsubscribe route - default export", () => {
  it("answers the safe page instead of throwing when nothing is configured", async () => {
    const { default: handler } = await import("./unsubscribe.js");
    const out = capture();

    await handler(get("/api/unsubscribe?token=garbage.sig"), out.res);

    expect(out.status()).toBe(400);
    expect(out.body()).toContain("Link nieprawidlowy lub wygasl");
  });
});
