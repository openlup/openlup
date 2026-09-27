import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { createRetiredPackagingDigestRoute } from "./packaging-digest-test.js";

describe("communications packaging digest test admin BFF route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps the retired route mounted through the observed admin wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "keeps the actual observed export terminal for %s without reading body or calling fetch",
    async (method) => {
      vi.stubEnv("APP_ENVIRONMENT", "development");
      vi.stubEnv("HIDDEN_SANDBOX_PREVIEW_TEST_ENFORCE", "false");
      const touched = vi.fn(() => { throw new Error(`${method} body surface touched`); });
      const fetchTouched = vi.fn(() => { throw new Error(`${method} fetch called`); });
      vi.stubGlobal("fetch", fetchTouched);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const req = { method, headers: { host: "localhost" }, query: {} } as Record<string, unknown>;
      for (const key of ["body", "json", "text", "arrayBuffer", "formData", "blob"]) {
        Object.defineProperty(req, key, { get: touched });
      }
      const res = response();

      await handler(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledOnce();
      expect(res.json).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(touched).not.toHaveBeenCalled();
      expect(fetchTouched).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "returns the same empty 404 for %s before request or dependency work",
    async (method) => {
      const touched = vi.fn(() => { throw new Error("retired dependency touched"); });
      const route = createRetiredPackagingDigestRoute({
        readRequest: touched,
        readEnv: touched,
        readToken: touched,
        createAuthClient: touched,
        createPort: touched,
        authorize: touched,
        fetch: touched,
      });
      const req = { method, headers: {}, query: {} } as never;
      Object.defineProperty(req, "body", { get: touched });
      const res = response();

      await route(req, res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledOnce();
      expect(res.json).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
      expect(touched).not.toHaveBeenCalled();
    },
  );

  it("contains no domain auth, handler, client, Supabase, Resend, provider, fetch, or write composition", () => {
    const source = readFileSync(new URL("./packaging-digest-test.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "readBearerToken",
      "authorizeAdmin",
      "createAdminAuthClient",
      "createCommunicationsPackagingDigestTestHandler",
      "createResendPackagingDigestTestPort",
      "createClient",
      "supabase",
      "resend",
      "fetch(",
      ".insert(",
      ".update(",
      ".rpc(",
    ]) expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
});

function response() {
  const res = {
    status: vi.fn(),
    end: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}
