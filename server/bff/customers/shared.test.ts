import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { IdentityVerifierPort } from "../../domains/auth/ports.js";
import {
  authenticateCustomerUser,
  authenticateCustomerUserWith,
  createCustomerClient,
  createCustomerClients,
  createCustomerReferenceReadComposition,
  createCustomerServiceClient,
  customerSelfServiceEnabled,
  type CustomerSupabaseClient,
} from "./shared.js";

function verifierReturning(
  principal: { principalId: string; email: string | null; emailVerified: boolean } | null,
): IdentityVerifierPort {
  return { verifyAccessToken: vi.fn(async () => principal) };
}

describe("authenticateCustomerUserWith", () => {
  it("rejects a missing access token without calling the verifier", async () => {
    const verifier = verifierReturning({ principalId: "u1", email: "a@b.com", emailVerified: true });
    const result = await authenticateCustomerUserWith(verifier, null);
    expect(result).toEqual({ ok: false, code: "UNAUTHORIZED", message: "Customer session required" });
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("UUID-keep: the resolved userId is the principal id (Supabase auth uuid)", async () => {
    const verifier = verifierReturning({ principalId: "auth-uuid-123", email: "a@b.com", emailVerified: true });
    const result = await authenticateCustomerUserWith(verifier, "tok");
    expect(result).toEqual({ ok: true, userId: "auth-uuid-123" });
    expect(verifier.verifyAccessToken).toHaveBeenCalledWith("tok");
  });

  it("rejects when the verifier cannot resolve the token", async () => {
    const verifier = verifierReturning(null);
    const result = await authenticateCustomerUserWith(verifier, "tok");
    expect(result).toEqual({ ok: false, code: "UNAUTHORIZED", message: "Customer session required" });
  });
});

describe("authenticateCustomerUser (default Supabase adapter)", () => {
  function clientReturning(result: { data: unknown; error: unknown }): CustomerSupabaseClient {
    return { auth: { getUser: vi.fn(async () => result) } } as unknown as CustomerSupabaseClient;
  }

  it("keeps the inline getUser behavior: userId = auth user id", async () => {
    const client = clientReturning({
      data: { user: { id: "u9", email: "x@y.com", email_confirmed_at: "2026-01-01", user_metadata: {} } },
      error: null,
    });
    expect(await authenticateCustomerUser(client, "tok")).toEqual({ ok: true, userId: "u9" });
  });

  it("returns UNAUTHORIZED on getUser error", async () => {
    const client = clientReturning({ data: { user: null }, error: { message: "bad" } });
    expect(await authenticateCustomerUser(client, "tok")).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Customer session required",
    });
  });
});

describe("customer shared DB boundary", () => {
  it("keeps the central customer auth helpers available through the shared BFF surface", () => {
    expect(createCustomerClient).toBeTypeOf("function");
    expect(createCustomerClients).toBeTypeOf("function");
    expect(createCustomerServiceClient).toBeTypeOf("function");
    expect(authenticateCustomerUser).toBeTypeOf("function");
    expect(authenticateCustomerUserWith).toBeTypeOf("function");
  });

  it("does not own Supabase SDK imports or local client construction", () => {
    const source = readFileSync("server/bff/customers/shared.ts", "utf8");

    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("createSupabaseIdentityVerifier");
  });
});

describe("customer reference read composition", () => {
  it("keeps sequential request bearers distinct through verification and actor binding", async () => {
    let bearer = "bearer-a";
    const request = { headers: {} } as never;
    const readToken = vi.fn(() => bearer);
    const createAuthenticationClient = vi.fn((_env, accessToken) => ({ accessToken }));
    const authenticate = vi.fn(async (_client, accessToken) => ({
      ok: true as const,
      userId: accessToken === "bearer-a" ? "actor-a" : "actor-b",
    }));
    const bindActor = vi.fn((accessToken) => ({
      asActor: vi.fn(async (_claims, work) => work({ accessToken })),
    }));
    const composition = createCustomerReferenceReadComposition(request, {
      readEnvironment: () => ({ url: "memory:", anonKey: "test" }),
      readToken,
      createAuthenticationClient,
      authenticate,
      bindActor,
    } as never);

    expect(composition).not.toBeNull();
    const first = await composition!.authorize();
    expect(first).toEqual({
      ok: true,
      userId: "actor-a",
      accessToken: "bearer-a",
    });
    composition!.actorPort("bearer-a");

    bearer = "bearer-b";
    const second = await composition!.authorize();
    expect(second).toEqual({
      ok: true,
      userId: "actor-b",
      accessToken: "bearer-b",
    });
    composition!.actorPort("bearer-b");

    expect(createAuthenticationClient.mock.calls.map((call) => call[1])).toEqual([
      "bearer-a",
      "bearer-b",
    ]);
    expect(authenticate.mock.calls.map((call) => call[1])).toEqual([
      "bearer-a",
      "bearer-b",
    ]);
    expect(bindActor.mock.calls.map((call) => call[0])).toEqual([
      "bearer-a",
      "bearer-b",
    ]);
  });

  it("fails closed if verification reports success without a request bearer", async () => {
    const bindActor = vi.fn();
    const composition = createCustomerReferenceReadComposition(
      { headers: {} } as never,
      {
        readEnvironment: () => ({ url: "memory:", anonKey: "test" }),
        readToken: () => null,
        createAuthenticationClient: vi.fn(() => ({})),
        authenticate: vi.fn(async () => ({
          ok: true,
          userId: "impossible-actor",
        })),
        bindActor,
      } as never,
    );

    await expect(composition!.authorize()).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Customer session required",
    });
    expect(bindActor).not.toHaveBeenCalled();
  });
});

describe("customerSelfServiceEnabled", () => {
  it("requires both customer auth UI and customer self-service flags to be exactly true", () => {
    const authFlag = "COMMERCE_V2_W12_CUSTOMER_AUTH_UI";
    const selfServiceFlag = "COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED";
    const previous = {
      [authFlag]: process.env[authFlag],
      [selfServiceFlag]: process.env[selfServiceFlag],
    };
    const setFlags = (auth: string | undefined, selfService: string | undefined) => {
      if (auth === undefined) delete process.env[authFlag];
      else process.env[authFlag] = auth;
      if (selfService === undefined) delete process.env[selfServiceFlag];
      else process.env[selfServiceFlag] = selfService;
    };

    try {
      setFlags(undefined, undefined);
      expect(customerSelfServiceEnabled()).toBe(false);
      setFlags("true", undefined);
      expect(customerSelfServiceEnabled()).toBe(false);
      setFlags(undefined, "true");
      expect(customerSelfServiceEnabled()).toBe(false);
      setFlags("false", "true");
      expect(customerSelfServiceEnabled()).toBe(false);
      setFlags("TRUE", "true");
      expect(customerSelfServiceEnabled()).toBe(false);
      setFlags("true", "true");
      expect(customerSelfServiceEnabled()).toBe(true);
    } finally {
      setFlags(previous[authFlag], previous[selfServiceFlag]);
    }
  });
});
