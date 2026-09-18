import { describe, expect, it, vi } from "vitest";
import {
  createFulfillmentPort,
  listFulfillmentProviderPlugins,
  readFulfillmentProviderReadiness,
  readOrderPaidFulfillmentReadiness,
  resolveFulfillmentProviderPlugin,
  selectOrderPaidFulfillmentProvider,
  wrapWithOmnipackOrderRouting,
} from "./outboxFulfillmentProvider.js";
import type { OrderPaidFulfillmentPort } from "../../server/domains/commerce/outboxOrderPaidFulfillmentPorts.js";
import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../src/domains/commerce/outboxEventContracts.js";

const STAGE_READY_ENV = {
  COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "simulator",
  OMNIPACK_PROVIDER_ENABLED: "true",
  COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
  COMMERCE_OMNIPACK_DISPATCH_MODE: "stage",
  COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "1",
  COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "1",
  OMNIPACK_USERNAME: "stage-user",
  OMNIPACK_PASSWORD: "stage-pass",
  OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech",
  OMNIPACK_ENV: "stage",
  OMNIPACK_WEBHOOK_TOKEN: "unguessable",
} as const;

function basePort(): OrderPaidFulfillmentPort {
  return { ensureFulfilledFromPaidOrder: vi.fn() };
}

describe("outbox fulfillment provider kernel", () => {
  it("registers the static server-side provider plugins", () => {
    expect(listFulfillmentProviderPlugins().map((plugin) => plugin.kind)).toEqual([
      "simulator",
      "manual",
      "dhl",
      "omnipack",
    ]);
  });

  it("wires the OmniPack 3PL lifecycle operations onto the plugin and tags the OSS type", () => {
    const byKind = Object.fromEntries(listFulfillmentProviderPlugins().map((plugin) => [plugin.kind, plugin]));

    // OmniPack = the canonical 3PL plugin: its workers are bound onto the method slots.
    expect(byKind.omnipack.type).toBe("3pl");
    expect(typeof byKind.omnipack.buildOutboundOrder).toBe("function");
    expect(typeof byKind.omnipack.dispatch).toBe("function");
    expect(typeof byKind.omnipack.reconcile).toBe("function");
    expect(typeof byKind.omnipack.syncStock).toBe("function");

    // DHL = the canonical direct-carrier plugin: outbound+dispatch live inside its
    // adapter reference, but retirement leaves it without an executable port.
    expect(byKind.dhl.type).toBe("direct-carrier");
    expect(byKind.dhl.createPort).toBeUndefined();
    expect(byKind.dhl.buildOutboundOrder).toBeUndefined();
    expect(byKind.dhl.syncStock).toBeUndefined();
    expect(byKind.simulator.type).toBe("simulator");
    expect(byKind.simulator.dispatch).toBeUndefined();
    expect(byKind.manual.type).toBe("manual");
  });

  it("exposes provider capability metadata without changing readiness gates", () => {
    const capabilities = Object.fromEntries(
      listFulfillmentProviderPlugins().map((plugin) => [plugin.kind, plugin.capabilities]),
    );

    expect(capabilities).toMatchObject({
      simulator: {
        role: "simulator",
        capabilities: { autoDispatch: true, trackingEvidence: true, labelCreation: true },
      },
      manual: {
        role: "manual",
        capabilities: { autoDispatch: false, trackingEvidence: true },
      },
      dhl: {
        role: "direct_carrier",
        capabilities: { autoDispatch: true, trackingEvidence: true, labelCreation: true, courierPickup: true },
        actionPolicy: { providerSpecificAdminActions: true },
      },
      omnipack: {
        role: "third_party_logistics",
        capabilities: { autoDispatch: true, stockEvidence: true, trackingEvidence: true, pickupPoint: true },
        actionPolicy: { providerSpecificAdminActions: false },
      },
    });
  });

  it("keeps simulator as the default hidden-preview auto-dispatch provider", () => {
    expect(resolveFulfillmentProviderPlugin({})?.kind).toBe("simulator");
    expect(resolveFulfillmentProviderPlugin({
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "hidden_preview_fulfillment",
    })?.kind).toBe("simulator");
    expect(readFulfillmentProviderReadiness({})).toEqual({ ok: true });
    expect(createFulfillmentPort(fakeClient(), {})).toBeTruthy();
  });

  it("rejects retired direct DHL selection for every legacy readiness combination", () => {
    const legacyDhlEnvironments = [
      {
        COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "dhl",
      },
      {
        COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "dhl",
        DHL_API_USERNAME: "user",
        DHL_API_PASSWORD: "pass",
        DHL_ACCOUNT_NUMBER: "123",
      },
      {
        COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "dhl",
        DHL_LIVE_PREVIEW_CONFIRMED: "true",
        DHL_API_USERNAME: "user",
        DHL_API_PASSWORD: "pass",
        DHL_ACCOUNT_NUMBER: "123",
      },
      {
        ...STAGE_READY_ENV,
        COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "dhl",
        DHL_LIVE_PREVIEW_CONFIRMED: "true",
        DHL_API_USERNAME: "dhl-user",
        DHL_API_PASSWORD: "dhl-pass",
        DHL_ACCOUNT_NUMBER: "123",
      },
    ];

    for (const env of legacyDhlEnvironments) {
      expect(resolveFulfillmentProviderPlugin(env as never)).toBeNull();
      expect(readFulfillmentProviderReadiness(env as never)).toEqual({
        ok: false,
        error: "fulfillment_provider_not_supported",
      });
      expect(createFulfillmentPort(fakeClient(), env as never)).toBeNull();
      expect(selectOrderPaidFulfillmentProvider(fakeClient(), env as never)).toMatchObject({
        eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
        providerKind: "unsupported",
        readiness: { ok: false, error: "fulfillment_provider_not_supported" },
        port: null,
      });
    }
  });

  it("records OmniPack obligations while keeping provider dispatch fail-closed", () => {
    const env = {
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "false",
    };

    expect(resolveFulfillmentProviderPlugin(env as never)?.kind).toBe("omnipack");
    expect(readFulfillmentProviderReadiness(env as never)).toEqual({
      ok: false,
      error: "omnipack_dispatch_disabled",
    });
    expect(readOrderPaidFulfillmentReadiness(env as never)).toEqual({ ok: true });
    expect(createFulfillmentPort(fakeClient(), env as never)).toBeTruthy();
  });

  it("selects the OmniPack order-paid bridge in shadow mode after explicit dispatch enablement", () => {
    const env = {
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "shadow",
    };

    expect(readFulfillmentProviderReadiness(env as never)).toEqual({ ok: true });
    expect(selectOrderPaidFulfillmentProvider(fakeClient(), env as never)).toMatchObject({
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      providerKind: "omnipack",
      readiness: { ok: true },
    });
    expect(createFulfillmentPort(fakeClient(), env as never)).toBeTruthy();
  });

  it("requires stage batch limit 1 before selecting the OmniPack stage bridge", () => {
    const env = {
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "stage",
      COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "2",
      COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "1",
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech",
      OMNIPACK_ENV: "stage",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
    };

    expect(readFulfillmentProviderReadiness(env as never)).toEqual({
      ok: false,
      error: "omnipack_stage_batch_limit_must_be_1",
    });
    expect(readOrderPaidFulfillmentReadiness(env as never)).toEqual({ ok: true });
    expect(createFulfillmentPort(fakeClient(), env as never)).toBeTruthy();
  });

  it("requires the real outbox dispatcher batch size before selecting the OmniPack stage bridge", () => {
    expect(readFulfillmentProviderReadiness({
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "stage",
      COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "1",
      COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "50",
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech",
      OMNIPACK_ENV: "stage",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
    } as never)).toEqual({
      ok: false,
      error: "omnipack_stage_outbox_dispatch_batch_size_must_match_dispatch_batch",
    });
  });

  it("selects the OmniPack stage bridge when credentials and the one-order gate are complete", () => {
    const env = {
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "stage",
      COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "1",
      COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "1",
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech",
      OMNIPACK_ENV: "stage",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
    };

    const selection = selectOrderPaidFulfillmentProvider(fakeClient(), env as never);

    expect(selection).toMatchObject({
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      providerKind: "omnipack",
      readiness: { ok: true },
    });
    expect(selection.port).toBeTruthy();
  });

  it("selects the OmniPack live bridge when dispatch is enabled with real production credentials", () => {
    const env = {
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "live",
      OMNIPACK_USERNAME: "prod-user",
      OMNIPACK_PASSWORD: "prod-pass",
      OMNIPACK_BASE_URL: "https://api.omnipack.tech",
      OMNIPACK_ENV: "production",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
    };

    // No batch gate for live — live wants throughput, not a one-order backlog cap.
    expect(readFulfillmentProviderReadiness(env as never)).toEqual({ ok: true });
    const selection = selectOrderPaidFulfillmentProvider(fakeClient(), env as never);
    expect(selection).toMatchObject({
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      providerKind: "omnipack",
      readiness: { ok: true },
    });
    expect(selection.port).toBeTruthy();
  });

  it("fails OmniPack live closed when the provider client is not configured", () => {
    expect(readFulfillmentProviderReadiness({
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "live",
    } as never)).toEqual({
      ok: false,
      error: "omnipack_provider_not_configured",
    });
  });

  it("fails OmniPack live closed when credentials point at a non-production environment", () => {
    const stageCredsInLiveMode = {
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "live",
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech",
      OMNIPACK_ENV: "stage",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
    };

    expect(readFulfillmentProviderReadiness(stageCredsInLiveMode as never)).toEqual({
      ok: false,
      error: "omnipack_provider_not_configured",
    });
    expect(readOrderPaidFulfillmentReadiness(stageCredsInLiveMode as never)).toEqual({ ok: true });
    expect(createFulfillmentPort(fakeClient(), stageCredsInLiveMode as never)).toBeTruthy();
  });

  it("keeps OmniPack live fail-closed when dispatch is not explicitly enabled", () => {
    expect(readFulfillmentProviderReadiness({
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "false",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "live",
      OMNIPACK_USERNAME: "prod-user",
      OMNIPACK_PASSWORD: "prod-pass",
      OMNIPACK_BASE_URL: "https://api.omnipack.tech",
      OMNIPACK_ENV: "production",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
    } as never)).toEqual({
      ok: false,
      error: "omnipack_dispatch_disabled",
    });
  });

  it("treats manual fulfillment as known but not auto-dispatchable", () => {
    const env = { COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "manual" };

    expect(resolveFulfillmentProviderPlugin(env)?.kind).toBe("manual");
    expect(readFulfillmentProviderReadiness(env)).toEqual({
      ok: false,
      error: "manual_fulfillment_not_auto_dispatchable",
    });
    expect(createFulfillmentPort(fakeClient(), env)).toBeNull();
  });

  it("keeps unsupported providers fail-closed", () => {
    const env = { COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "typo" };

    expect(resolveFulfillmentProviderPlugin(env)).toBeNull();
    expect(readFulfillmentProviderReadiness(env)).toEqual({
      ok: false,
      error: "fulfillment_provider_not_supported",
    });
    expect(createFulfillmentPort(fakeClient(), env)).toBeNull();
    expect(selectOrderPaidFulfillmentProvider(fakeClient(), env)).toMatchObject({
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      providerKind: "unsupported",
      readiness: { ok: false, error: "fulfillment_provider_not_supported" },
      port: null,
    });
  });
  it("wraps the default port with per-order OmniPack routing when OmniPack is stage-ready", () => {
    const base = basePort();
    const wrapped = wrapWithOmnipackOrderRouting(fakeClient(), STAGE_READY_ENV as never, base);
    expect(wrapped).not.toBe(base);
  });

  it("wraps even when OmniPack is not ready so selected OmniPack orders fail closed", () => {
    const base = basePort();
    const wrapped = wrapWithOmnipackOrderRouting(fakeClient(), {
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "simulator",
    } as never, base);
    expect(wrapped).not.toBe(base);
  });

  it("does not wrap when the global default provider is already OmniPack", () => {
    const base = basePort();
    const wrapped = wrapWithOmnipackOrderRouting(fakeClient(), {
      ...STAGE_READY_ENV,
      COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
    } as never, base);
    expect(wrapped).toBe(base);
  });
});

function fakeClient() {
  return {
    rpc: vi.fn(),
    from: vi.fn(),
    storage: { from: vi.fn() },
  } as never;
}
