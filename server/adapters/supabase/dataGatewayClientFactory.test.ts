import { describe, expect, it, vi } from "vitest";

import {
  createActorClient,
  createServiceClient,
  readSupabaseActorDataGatewayEnv,
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "./dataGatewayClientFactory.js";

const ENV: SupabaseDataGatewayEnv = {
  url: "https://proj.supabase.co",
  anonKey: "anon-key",
  serviceRoleKey: "service-role-key",
};

describe("readSupabaseDataGatewayEnv", () => {
  it("reads url + anon + service role with the same precedence the inline sites use", () => {
    const env = readSupabaseDataGatewayEnv({
      SUPABASE_URL: "https://a.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
    });
    expect(env).toEqual({ url: "https://a.supabase.co", anonKey: "anon", serviceRoleKey: "svc" });
  });

  it("prefers VITE_ vars and falls back through the chain", () => {
    const env = readSupabaseDataGatewayEnv({
      VITE_SUPABASE_URL: "https://vite.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "pub",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
    });
    expect(env).toEqual({ url: "https://vite.supabase.co", anonKey: "pub", serviceRoleKey: "svc" });
  });

  it("prefers the canonical publishable key when the legacy alias differs", () => {
    const env = readSupabaseDataGatewayEnv({
      SUPABASE_URL: "https://a.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "canonical",
      VITE_SUPABASE_ANON_KEY: "legacy",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
    });
    expect(env?.anonKey).toBe("canonical");
  });

  it("returns null when url or service role key is missing", () => {
    expect(readSupabaseDataGatewayEnv({ SUPABASE_SERVICE_ROLE_KEY: "svc" })).toBeNull();
    expect(readSupabaseDataGatewayEnv({ SUPABASE_URL: "https://x" })).toBeNull();
  });

  it("allows an empty anon key (service-only deployments)", () => {
    const env = readSupabaseDataGatewayEnv({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
    });
    expect(env).toEqual({ url: "https://x.supabase.co", anonKey: "", serviceRoleKey: "svc" });
  });
});

describe("readSupabaseActorDataGatewayEnv", () => {
  it("reads actor env without requiring the service-role key", () => {
    const env = readSupabaseActorDataGatewayEnv({
      VITE_SUPABASE_URL: "https://actor.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "pub",
    });
    expect(env).toEqual({
      url: "https://actor.supabase.co",
      anonKey: "pub",
      serviceRoleKey: "",
    });
  });

  it("returns null when actor url or anon key is missing", () => {
    expect(readSupabaseActorDataGatewayEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: "pub" })).toBeNull();
    expect(readSupabaseActorDataGatewayEnv({ VITE_SUPABASE_URL: "https://x" })).toBeNull();
  });
});

describe("createServiceClient", () => {
  it("builds an elevated client with the byte-identical inline option shape", () => {
    const factory = vi.fn(() => ({ tag: "service" }));
    const client = createServiceClient(ENV, factory);
    expect(client).toEqual({ tag: "service" });
    expect(factory).toHaveBeenCalledWith("https://proj.supabase.co", "service-role-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });
});

describe("createActorClient", () => {
  it("attaches the Bearer header when a token is present", () => {
    const factory = vi.fn(() => ({ tag: "actor" }));
    createActorClient(ENV, "jwt-token", factory);
    expect(factory).toHaveBeenCalledWith("https://proj.supabase.co", "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: "Bearer jwt-token" } },
    });
  });

  it("omits the Authorization header when no token (anon, RLS-bound)", () => {
    const factory = vi.fn(() => ({ tag: "anon" }));
    createActorClient(ENV, null, factory);
    expect(factory).toHaveBeenCalledWith("https://proj.supabase.co", "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: {} },
    });
  });

  it("throws when an actor client is requested without an anon key", () => {
    const factory = vi.fn();
    expect(() => createActorClient({ ...ENV, anonKey: "" }, "jwt", factory)).toThrow(
      /actor_requires_anon_key/,
    );
    expect(factory).not.toHaveBeenCalled();
  });
});
