import { describe, expect, it } from "vitest";
import {
  FULFILLMENT_PROVIDER_DESCRIPTORS,
  FULFILLMENT_PROVIDER_OPERATIONS_BY_TYPE,
  fulfillmentProviderType,
  listFulfillmentProviderDescriptors,
  readOmnipackKernelReadiness,
  readOmnipackStageBatchReadiness,
  resolveFulfillmentProviderDescriptor,
  validateDeliverySelectionForKind,
  type CanonicalDeliverySelection,
} from "./fulfillmentKernel.js";

describe("fulfillment kernel — provider registry", () => {
  it("registers the static provider descriptors in a stable order", () => {
    expect(listFulfillmentProviderDescriptors().map((d) => d.kind)).toEqual([
      "simulator",
      "manual",
      "dhl",
      "omnipack",
    ]);
  });

  it("classifies each provider into its OSS type from the capability role (not the carrier)", () => {
    expect(fulfillmentProviderType("simulator")).toBe("simulator");
    expect(fulfillmentProviderType("manual")).toBe("manual");
    expect(fulfillmentProviderType("dhl")).toBe("direct-carrier");
    expect(fulfillmentProviderType("omnipack")).toBe("3pl");
  });

  it("derives each descriptor's operation support + delivered-ownership from its type/capability map", () => {
    const byKind = Object.fromEntries(FULFILLMENT_PROVIDER_DESCRIPTORS.map((d) => [d.kind, d]));

    expect(byKind.omnipack.type).toBe("3pl");
    expect(byKind.omnipack.operations).toEqual(FULFILLMENT_PROVIDER_OPERATIONS_BY_TYPE["3pl"]);
    expect(byKind.omnipack.operations).toEqual({
      buildOutboundOrder: true,
      dispatch: true,
      reconcile: true,
      parseWebhook: true,
      syncStock: true,
    });
    // No registered provider owns the delivered notice: since 2026-09-14 our
    // delivered mail goes out next to OmniPack's carrier notice (owner decision).
    expect(byKind.omnipack.ownsDeliveredNotification).toBe(false);
    expect(byKind.dhl.ownsDeliveredNotification).toBe(false);
    expect(byKind.simulator.ownsDeliveredNotification).toBe(false);
    expect(byKind.manual.ownsDeliveredNotification).toBe(false);

    // Direct-carrier (DHL): no stock sync, no webhook/reconcile lifecycle of its own.
    expect(byKind.dhl.operations.syncStock).toBe(false);
    expect(byKind.dhl.operations.reconcile).toBe(false);
    // Manual is operator-driven: no auto operations.
    expect(byKind.manual.operations).toEqual({
      buildOutboundOrder: false,
      dispatch: false,
      reconcile: false,
      parseWebhook: false,
      syncStock: false,
    });
  });

  it("resolves the configured provider by alias and treats unknown providers as unsupported", () => {
    expect(resolveFulfillmentProviderDescriptor({})?.kind).toBe("simulator");
    expect(
      resolveFulfillmentProviderDescriptor({
        COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "hidden_preview_fulfillment",
      })?.kind,
    ).toBe("simulator");
    expect(resolveFulfillmentProviderDescriptor({ COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "dhl" })?.kind).toBe("dhl");
    expect(resolveFulfillmentProviderDescriptor({ COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "typo" })).toBeNull();
  });
});

describe("fulfillment kernel — THREE-LAYER INVARIANT (never infer provider from carrier)", () => {
  function selection(overrides: Partial<CanonicalDeliverySelection>): CanonicalDeliverySelection {
    return { providerKind: null, carrierKind: null, carrierCode: null, serviceCode: null, ...overrides };
  }

  it("selects OmniPack ONLY from an explicit providerKind, never from the carrier", () => {
    // A selection that names a carrier+service but NO providerKind must NOT validate
    // as OmniPack — the provider is its own layer, never inferred from the carrier.
    expect(
      validateDeliverySelectionForKind(
        "omnipack",
        selection({ providerKind: null, carrierKind: "inpost", carrierCode: "inpost", serviceCode: "inpost-locker" }),
      ),
    ).toEqual({ ok: false, error: "selection_provider_kind_not_omnipack" });
  });

  it("requires an explicit carrier+service code for an OmniPack selection", () => {
    expect(
      validateDeliverySelectionForKind("omnipack", selection({ providerKind: "omnipack", carrierCode: null, serviceCode: null })),
    ).toEqual({ ok: false, error: "omnipack_requires_carrier_and_service_codes" });

    expect(
      validateDeliverySelectionForKind(
        "omnipack",
        selection({ providerKind: "omnipack", carrierCode: "dhl", serviceCode: "dhl-courier" }),
      ),
    ).toEqual({ ok: true });
  });

  it("rejects an OmniPack selection that is missing entirely", () => {
    expect(validateDeliverySelectionForKind("omnipack", null)).toEqual({
      ok: false,
      error: "selection_provider_kind_not_omnipack",
    });
  });

  it("treats a selection naming a DIFFERENT provider as a layer mismatch for non-3PL providers", () => {
    expect(
      validateDeliverySelectionForKind("dhl", selection({ providerKind: "omnipack", carrierCode: "dhl", serviceCode: "x" })),
    ).toEqual({ ok: false, error: "selection_provider_kind_mismatch" });
    // Absence of a provider selection is fine for a direct carrier / simulator.
    expect(validateDeliverySelectionForKind("dhl", null)).toEqual({ ok: true });
    expect(validateDeliverySelectionForKind("simulator", selection({ carrierCode: "inpost" }))).toEqual({ ok: true });
  });
});

describe("fulfillment kernel — OmniPack pure readiness gates", () => {
  it("keeps OmniPack fail-closed until dispatch is explicitly enabled", () => {
    expect(readOmnipackKernelReadiness({ COMMERCE_OMNIPACK_DISPATCH_ENABLED: "false" })).toEqual({
      ok: false,
      error: "omnipack_dispatch_disabled",
    });
  });

  it("treats live auto-dispatch as kernel-clean once dispatch is enabled (creds gate lives in the composition root)", () => {
    // The kernel no longer special-cases live: COMMERCE_OMNIPACK_DISPATCH_ENABLED
    // is the single intent switch. The real-credentials / production-environment
    // fail-closed for live is enforced by readOmnipackComposedReadiness (which can
    // reach server/infra), not here.
    expect(
      readOmnipackKernelReadiness({ COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true", COMMERCE_OMNIPACK_DISPATCH_MODE: "live" }),
    ).toEqual({ ok: true });
  });

  it("allows OmniPack shadow mode without the stage batch gate", () => {
    expect(
      readOmnipackKernelReadiness({ COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true", COMMERCE_OMNIPACK_DISPATCH_MODE: "shadow" }),
    ).toEqual({ ok: true });
  });

  it("enforces the controlled one-order stage batch gate", () => {
    expect(
      readOmnipackStageBatchReadiness({ COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "1" }),
    ).toEqual({
      ok: false,
      error: "omnipack_stage_outbox_dispatch_batch_size_must_match_dispatch_batch",
    });
    expect(
      readOmnipackStageBatchReadiness({ COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "1", COMMERCE_OUTBOX_BATCH_SIZE: "1" }),
    ).toEqual({
      ok: false,
      error: "omnipack_stage_outbox_dispatch_batch_size_must_match_dispatch_batch",
    });
    expect(
      readOmnipackStageBatchReadiness({
        COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "1",
        COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "1",
      }),
    ).toEqual({ ok: true });
    expect(readOmnipackStageBatchReadiness({ COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "2" })).toEqual({
      ok: false,
      error: "omnipack_stage_batch_limit_must_be_1",
    });
  });

  it("requires the real outbox dispatcher batch size to match controlled stage batches", () => {
    expect(readOmnipackStageBatchReadiness({
      COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "3",
      OMNIPACK_STAGE_BATCH_CONFIRMED: "true",
      OMNIPACK_STAGE_BATCH_MAX_ORDERS: "3",
      COMMERCE_OUTBOX_BATCH_SIZE: "3",
    })).toEqual({
      ok: false,
      error: "omnipack_stage_outbox_dispatch_batch_size_must_match_dispatch_batch",
    });
    expect(readOmnipackStageBatchReadiness({
      COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "3",
      OMNIPACK_STAGE_BATCH_CONFIRMED: "true",
      OMNIPACK_STAGE_BATCH_MAX_ORDERS: "3",
      COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "3",
    })).toEqual({ ok: true });
  });
});
