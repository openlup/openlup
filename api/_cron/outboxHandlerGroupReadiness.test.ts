import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readOutboxHandlerGroupReadiness } from "./outboxHandlerGroupReadiness.js";

const EMAIL_READY_ENV = {
  RESEND_API_KEY: "re_test",
  SUPABASE_URL: "https://abc123.supabase.co",
};

describe("outbox handler group readiness", () => {
  it("forwards the complete direct fulfillment activation set in stock Compose", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    for (const name of [
      "COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED",
      "COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER",
      "FULFILLMENT_PORT_KEY",
      "ACCOUNTING_REQUEST_ENABLED",
    ]) expect(compose).toContain(`${name}: \${${name}:-`);
  });
  it("fails closed when no handler group is ready", () => {
    const result = readOutboxHandlerGroupReadiness({});

    expect(result.readyGroups).toEqual([]);
    expect(result.noReadyError).toBe("provider_not_configured");
    expect(result.disabledHandlerGroups).toMatchObject({
      transactional_email: "provider_not_configured",
      subscription_email: "provider_not_configured",
    });
  });

  it("keeps transactional and subscription ready without marketing flags", () => {
    const result = readOutboxHandlerGroupReadiness(EMAIL_READY_ENV);

    expect(result.readyGroups).toEqual(["transactional_email", "subscription_email"]);
    expect(result.disabledHandlerGroups).toEqual({});
    expect(result.noReadyError).toBeNull();
  });

  it("isolates marketing readiness from ready email groups", () => {
    const result = readOutboxHandlerGroupReadiness({
      ...EMAIL_READY_ENV,
      COMMERCE_ABANDONED_CART_ENABLED: "true",
    });

    expect(result.readyGroups).toEqual(["transactional_email", "subscription_email"]);
    expect(result.disabledHandlerGroups).toEqual({
      marketing_email: "unsubscribe_token_secret_required",
    });
  });

  it("retires direct DHL fulfillment without disabling ready email groups", () => {
    const result = readOutboxHandlerGroupReadiness({
      ...EMAIL_READY_ENV,
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED: "true",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "dhl",
    });

    expect(result.readyGroups).toEqual(["transactional_email", "subscription_email"]);
    expect(result.disabledHandlerGroups).toEqual({
      fulfillment: "fulfillment_provider_not_supported",
    });
  });

  it("fails the direct fulfillment group closed without its opaque port key", () => {
    const result = readOutboxHandlerGroupReadiness({
      PLATFORM_BUNDLE: "node-postgres",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED: "true",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "simulator",
      ACCOUNTING_REQUEST_ENABLED: "true",
    });

    expect(result.readyGroups).toEqual([]);
    expect(result.disabledHandlerGroups.fulfillment).toBe("fulfillment_port_key_required");
    expect(result.noReadyError).toBe("fulfillment_port_key_required");
  });

  it("admits the direct simulator only with the opaque port key", () => {
    const result = readOutboxHandlerGroupReadiness({
      PLATFORM_BUNDLE: "node-postgres",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED: "true",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "simulator",
      FULFILLMENT_PORT_KEY: "operator-provisioned-port",
      ACCOUNTING_REQUEST_ENABLED: "true",
    });

    expect(result.readyGroups).toEqual(["fulfillment"]);
    expect(result.disabledHandlerGroups.fulfillment).toBeUndefined();
  });

  it("fails direct fulfillment closed when its paid-order accounting duty is disabled", () => {
    const result = readOutboxHandlerGroupReadiness({
      PLATFORM_BUNDLE: "node-postgres",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED: "true",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "simulator",
      FULFILLMENT_PORT_KEY: "operator-provisioned-port",
    });

    expect(result.readyGroups).toEqual([]);
    expect(result.disabledHandlerGroups.fulfillment).toBe("accounting_request_required");
    expect(result.noReadyError).toBe("accounting_request_required");
  });

  it("keeps the local OmniPack obligation handler ready when provider dispatch is off", () => {
    const result = readOutboxHandlerGroupReadiness({
      ...EMAIL_READY_ENV,
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED: "true",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "false",
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech",
      OMNIPACK_ENV: "stage",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
    });

    expect(result.readyGroups).toEqual(["transactional_email", "subscription_email", "fulfillment"]);
    expect(result.disabledHandlerGroups).toEqual({});
  });

  it("registers OmniPack fulfillment when shadow dispatch is explicitly enabled", () => {
    const result = readOutboxHandlerGroupReadiness({
      ...EMAIL_READY_ENV,
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED: "true",
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "shadow",
    });

    expect(result.readyGroups).toEqual(["transactional_email", "subscription_email", "fulfillment"]);
    expect(result.disabledHandlerGroups).toEqual({});
  });
});
