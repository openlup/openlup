import { describe, expect, it, vi } from "vitest";
import type { IdentityVerifierPort } from "../../domains/auth/ports.js";
import {
  authenticateCustomerUser,
  authenticateCustomerUserWith,
  createCustomerClient,
  createCustomerClients,
  createCustomerServiceClient,
  type CustomerSupabaseClient,
} from "./auth.js";

const mockCreateClient = vi.hoisted(() => vi.fn((url: string, key: string, options: unknown) => ({
  key,
  options,
  url,
})));

vi.mock("@supabase/supabase-js", () => ({ createClient: mockCreateClient }));

function verifierReturning(
  principal: { principalId: string; email: string | null; emailVerified: boolean } | null,
): IdentityVerifierPort {
  return { verifyAccessToken: vi.fn(async () => principal) };
}

describe("customer auth client factories", () => {
  it("creates an anon customer client with the bearer token header", () => {
    const client = createCustomerClient({ url: "https://db.test", anonKey: "anon" }, "tok");

    expect(client).toMatchObject({ url: "https://db.test", key: "anon" });
    expect(mockCreateClient).toHaveBeenCalledWith("https://db.test", "anon", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: "Bearer tok" } },
    });
  });

  it("creates a service-role customer client with no persisted auth", () => {
    const client = createCustomerServiceClient({
      url: "https://db.test",
      anonKey: "anon",
      serviceRoleKey: "service",
    });

    expect(client).toMatchObject({ url: "https://db.test", key: "service" });
    expect(mockCreateClient).toHaveBeenCalledWith("https://db.test", "service", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("returns both customer and service clients for self-service routes", () => {
    const clients = createCustomerClients({
      url: "https://db.test",
      anonKey: "anon",
      serviceRoleKey: "service",
    }, "tok");

    expect(clients.customerClient).toMatchObject({ key: "anon" });
    expect(clients.serviceClient).toMatchObject({ key: "service" });
  });
});

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

describe("authenticateCustomerUser", () => {
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
