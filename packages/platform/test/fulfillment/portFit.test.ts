import { expect, expectTypeOf, it } from "vitest";
import * as fulfillment from "../../src/fulfillment/index.js";
const { readFulfillmentCapabilities } = fulfillment;
import type { FulfillmentCapabilityDescriptor, FulfillmentObservation, FulfillmentObservationPort, FulfillmentReadbackResult, FulfillmentStockSyncProvider, FulfillmentStockSyncPort, FulfillmentProductSyncProvider, FulfillmentProductSyncPort, FulfillmentStorePort } from "../../src/fulfillment/contracts/index.js";

const profile = (): FulfillmentCapabilityDescriptor => ({
  providerRef: "warehouse-a", role: "warehouse", defaultOff: true, selected: false,
  readiness: { ready: false, refusal: { reason: "not_ready", phase: "selection", retryable: false } },
  operations: { dispatch: { supported: true }, readback: { supported: true }, exactAbsence: { supported: false, reason: "not_exposed" }, verifyObservation: { supported: true }, syncStock: { supported: true }, syncProducts: { supported: true }, labelCreate: { supported: false, reason: "not_exposed" }, labelRead: { supported: false, reason: "host_only" }, labelVoid: { supported: false, reason: "not_exposed" }, cancel: { supported: false, reason: "not_exposed" }, pickupPoint: { supported: true }, courierPickup: { supported: false, reason: "not_exposed" } },
  authentication: "token", freshness: "not_available", ownsDeliveredNotification: true, stockAuthority: "external_stock_master_with_local_reservations", labelReadOwner: "host_storage",
  actionPolicy: { providerSpecificAdminActions: true, genericAdminActions: false, mutationSurface: "provider_adapter" },
});

it("retains event identity, authenticated-time limits, contention, exact absence and partial sync outcomes (G6–G12)", () => {
  expectTypeOf<FulfillmentObservation["fact"]["occurredAt"]>().toEqualTypeOf<string | null>();
  expectTypeOf<FulfillmentObservation>().toHaveProperty("eventKind");
  expectTypeOf<FulfillmentObservation>().toHaveProperty("eventKey");
  expectTypeOf<FulfillmentObservation>().toHaveProperty("firstReceivedAt");
  expectTypeOf<Parameters<FulfillmentObservationPort["verifyAndNormalize"]>[0]["rawBody"]>().toEqualTypeOf<Uint8Array>();
  const diagnostics: FulfillmentObservation["diagnostics"] = { stockContention: { sqlState: "55P03", phase: "provider_stock_consumed", retryable: true }, annotation: "recorded", recoveredPickedReceipt: { receiptRef: "receipt-a", closed: true } };
  expect(diagnostics.recoveredPickedReceipt?.closed).toBe(true);
  const absent: FulfillmentReadbackResult = { kind: "absent", scope: { providerRef: "warehouse-a", requestKey: "original-key", fulfillmentRef: "fulfillment-a", externalRef: null }, proof: { kind: "authoritative_exact_lookup", evidenceRef: "evidence:00000000-0000-4000-8000-000000000001", checkedAt: "2026-10-21T10:00:00Z" } };
  expect(absent.proof.kind).toBe("authoritative_exact_lookup");
  // @ts-expect-error absence without exact scope and proof is not a valid result
  const invalidAbsence: FulfillmentReadbackResult = { kind: "absent" };
  expect(invalidAbsence).not.toEqual(absent);
  const unknown: FulfillmentReadbackResult = { kind: "unknown", refusal: { reason: "local_missing", phase: "readback", retryable: false } };
  expect(unknown.kind).toBe("unknown");
  type Snapshot = Awaited<ReturnType<FulfillmentStockSyncProvider["getStock"]>>[number];
  expectTypeOf<Snapshot["sourceRevision"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Snapshot["revisionSource"]>().toEqualTypeOf<"provider" | "collection" | "unknown">();
  type Movement = Awaited<ReturnType<FulfillmentStockSyncProvider["getStockMovements"]>>[number];
  expectTypeOf<Movement>().toHaveProperty("lotRef");
  expectTypeOf<Movement>().toHaveProperty("expirationDate");
  expectTypeOf<Movement["occurredAt"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Awaited<ReturnType<FulfillmentStockSyncPort["recordStockSnapshot"]>>>().toEqualTypeOf<{ replayed: boolean; readBack: boolean }>();
  expectTypeOf<Awaited<ReturnType<FulfillmentProductSyncProvider["ensureProduct"]>>>().toEqualTypeOf<{ replayed: boolean } | null>();
  expectTypeOf<Awaited<ReturnType<FulfillmentProductSyncPort["upsertPulledPack"]>>["conflict"]>().toEqualTypeOf<"none" | "local_locked_mismatch" | "ean_owned_by_other_sku" | "sku_not_found">();
  expectTypeOf<FulfillmentStorePort>().toHaveProperty("prepare");
  expectTypeOf<FulfillmentStorePort>().toHaveProperty("claim");
  expectTypeOf<FulfillmentStorePort>().toHaveProperty("begin");
  expectTypeOf<FulfillmentStorePort>().toHaveProperty("finalize");
  expectTypeOf<FulfillmentStorePort>().toHaveProperty("acknowledge");
});

it("keeps injected capabilities default-off with independent selection, readiness, ownership and neutral names (G13/W7)", () => {
  const descriptor = profile();
  const selection = { providerRef: descriptor.providerRef, carrierRef: "carrier-a", serviceRef: "service-a", deliveryKind: "courier" as const, pickupPoint: null };
  for (const empty of [null, undefined, { ...selection, providerRef: "" }, { ...selection, providerRef: "   " }]) expect(readFulfillmentCapabilities([descriptor], empty)).toMatchObject({ kind: "refused", refusal: { reason: "selection_required" } });
  expect(readFulfillmentCapabilities([descriptor], { ...selection, providerRef: null })).toMatchObject({ kind: "refused", refusal: { reason: "selection_required" } });
  expect(readFulfillmentCapabilities([descriptor], { ...selection, providerRef: "unknown" })).toMatchObject({ kind: "refused", refusal: { reason: "provider_mismatch" } });
  expect(readFulfillmentCapabilities([descriptor], { ...selection, carrierRef: null })).toMatchObject({ kind: "refused", refusal: { reason: "carrier_service_required" } });
  expect(readFulfillmentCapabilities([descriptor], selection)).toMatchObject({ kind: "refused", refusal: { reason: "disabled" } });
  descriptor.selected = true;
  expect(readFulfillmentCapabilities([descriptor], selection)).toMatchObject({ kind: "refused", refusal: { reason: "not_ready" } });
  descriptor.readiness = { ready: true };
  expect(readFulfillmentCapabilities([descriptor], selection)).toEqual({ kind: "selected", descriptor });
  expect(descriptor.operations.exactAbsence).toEqual({ supported: false, reason: "not_exposed" });
  expect(descriptor.freshness).toBe("not_available");
  descriptor.role = "direct_carrier"; descriptor.selected = false;
  expect(readFulfillmentCapabilities([descriptor], selection)).toMatchObject({ kind: "refused", refusal: { reason: "disabled" } });
  expect(Object.keys(fulfillment).sort()).toEqual([
    "CANONICAL_LOCAL_FULFILLMENT_STATUSES", "CUSTOMER_STEP_SEQUENCE", "FULFILLMENT_STATUS_MAP",
    "buildCommerceFulfillmentOrdersListResponse", "buildCommerceFulfillmentOrderDetailResponse", "createFulfillmentShipmentsOverviewHandler", "fulfillmentProgressPresentation",
    "collectPaidFulfillmentRecoveryCandidates", "createFulfillmentServices", "createFulfillmentCommandLedger", "createOutboxOrderPaidFulfillmentHandler", "runFulfillmentDispatchWorker",
    "verifyAndNormalizeFulfillmentObservation", "applyFulfillmentObservationEffects", "reconcileFulfillmentObservations", "runFulfillmentStockSyncWorker", "runFulfillmentProductSyncWorker", "createFulfillmentLowStockEvidenceHandler", "createProductReconciliationEvidenceHandler", "runFulfillmentAdapterConformance",
    "createPostgresFulfillmentShipmentSpinePort", "createPostgresFulfillmentLowStockEvidencePort", "createPostgresFulfillmentStockSyncPort", "createPostgresPaidFulfillmentRecoveryOpsPort", "createPostgresFulfillmentDispatchStore", "createPostgresPaidFulfillmentHandoffStore", "createPostgresDeliveryAlignmentPort", "readDeliveryAlignment", "FULFILLMENT_MIGRATIONS", "FULFILLMENT_NATIVE_CAPABILITIES",
    "canonicalStatusToken", "customerStepFromSignals", "parseFulfillmentFact", "parseFulfillmentTransitionConflict",
    "phaseIndexForStep", "readFulfillmentCapabilities", "stepForToken", "stepLabelKey", "stepUsesTruckIcon", "timelineLabelForStep", "trackingPhaseKeyForStep",
    "createAdminCommerceFulfillmentOrdersListHandler", "createAdminCommerceFulfillmentOrderDetailHandler", "createAdminCommerceFulfillmentCreateOrderHandler", "createAdminCommerceFulfillmentRecordProviderAttemptHandler", "createAdminCommerceFulfillmentRecordLabelHandler", "createAdminCommerceFulfillmentHandOffHandler", "createAdminCommerceFulfillmentTrackingEventHandler", "createAdminCommerceFulfillmentCancelOrderHandler", "createAdminCommerceOrderRequestReplacementShipmentHandler", "CommerceFulfillmentConflictError", "readFulfillmentDelay", "readFulfillmentLabel", "cleanupFulfillmentLabel", "currentParcel", "currentParcelFor", "currentParcelPerOrder", "currentParcelFirst", "belongsToParcel", "rowsForParcel", "parcelSequenceNo", "compareParcelPrecedence", "FULFILLMENT_NATIVE_UNSUPPORTED", "createNativeUnsupportedFulfillmentPorts", "FULFILLMENT_REPLACEMENT_REFUSALS",
  ].sort());
});
