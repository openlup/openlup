import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClientsAgentReadGovernance } from "./governance.js";

const ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "COMMERCE_AGENT_CUSTOMER_READ_ENABLED",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildClientsAgentReadGovernance", () => {
  it("returns undefined when the service-role env is absent", () => {
    expect(buildClientsAgentReadGovernance()).toBeUndefined();
  });

  it("builds governance with the flag state + an audit client when env is present", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = "true";

    const governance = buildClientsAgentReadGovernance();
    expect(governance).toBeDefined();
    expect(governance?.flagEnabled).toBe(true);
    expect(typeof governance?.auditClient.rpc).toBe("function");
  });

  it("defaults flagEnabled to false when the flag is unset", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";

    expect(buildClientsAgentReadGovernance()?.flagEnabled).toBe(false);
  });
});
