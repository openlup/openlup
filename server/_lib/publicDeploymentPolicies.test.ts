import { describe, expect, it } from "vitest";
import { evaluateDeploymentRoutePolicy, readFakturowniaReadinessConfig, resolveEgressMode, resolveEmailEnvironmentTag } from "./publicDeploymentPolicies.js";

describe("public deployment defaults", () => {
  it("allows reads and health while refusing mutation, provider and webhook routes", () => {
    const route = (surface: "public" | "health" | "webhook", risk: "read" | "health" | "mutation" | "provider") =>
      evaluateDeploymentRoutePolicy({ route: "/probe", domain: "probe", surface, risk });
    expect(route("public", "read").allowed).toBe(true);
    expect(route("health", "health").allowed).toBe(true);
    for (const decision of [route("public", "mutation"), route("public", "provider"), route("webhook", "read")])
      expect(decision).toEqual({ allowed: false, reason: "adopter_policy_required" });
  });

  it("never activates the bundled provider without an adopter policy", () => {
    expect(readFakturowniaReadinessConfig({ FAKTUROWNIA_PROVIDER_ENABLED: "true", FAKTUROWNIA_API_TOKEN: "token", FAKTUROWNIA_BASE_URL: "https://example.invalid" }).enabled).toBe(false);
  });

  it("permits only sink or drop regardless of production-like markers", () => {
    const unsafeMarkers = { APP_ENVIRONMENT: "production", PRODUCTION_ROLLOUT_CONFIRMED: "true", EMAIL_DELIVERY_PROFILE: "production_like", COMMS_SANDBOX_DIRECT_RECIPIENT_ALLOWLIST: "buyer@example.com", RESEND_API_KEY: "live" };
    expect(resolveEmailEnvironmentTag()).toBe("non_production");
    expect(resolveEgressMode(unsafeMarkers, "buyer@example.com").mode).toBe("drop");
    expect(resolveEgressMode({ ...unsafeMarkers, COMMS_SANDBOX_SINK_ADDRESS: "sink@example.invalid" }, "buyer@example.com")).toMatchObject({ mode: "sandbox_sink", recipient: "sink@example.invalid" });
  });
});
