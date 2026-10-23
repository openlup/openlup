import { expect, it, vi } from "vitest";
import { createPostgresFulfillmentShipmentSpinePort, reconcileFulfillmentObservations as run } from "../../src/fulfillment/index.js";
import { normalizeReconciliationTimestamp } from "../../src/fulfillment/providerReconciliationTimestamp.js";
import { enrichTrackingReference, uniqueTrackingReferences } from "../../src/fulfillment/providerTrackingReferences.js";
import { ingressFixture, observation } from "./fixtures.js";

function fixture(status = "label_created", latest: string | null = null) {
  const f = ingressFixture();
  const input: Parameters<typeof run>[0] = {
    batchSize: 10,
    readPage: async () => [{ kind: "found", externalRef: "external-a", createdAt: null, updatedAt: f.inbound.size ? null : "2026-10-21T11:00:00Z", observation: observation("in_transit", "2026-10-21T11:00:00Z") }],
    localPersistence: { async readLocalFulfillmentStatus() { return status; }, async latestStatusOccurredAt() { return latest; }, async readHandedOverAt() { return latest; } },
    lifecycle: { ...f.input.lifecycle,
      async recordQuarantine(_observation, reason) { f.trace.push(`quarantine:${reason}`); return { replayed: false }; },
      async recordProviderException() { f.trace.push("exception"); return { replayed: false }; },
      async readDeliveryCarrier() { f.trace.push("carrier"); return { carrierRef: "local-carrier", serviceRef: "local-service" }; },
      trackingCodecs: { normalizeCarrier: input => input.carrierRef, publicUrl: (_carrier, number) => `https://tracking.example.invalid/${number}` },
      invoiceFailure: () => ({ permanent: true, identifier: "invoice_order_not_found", sqlstate: "22023", benign: true }),
      classifyStateConflict: () => null,
    },
  };
  return { ...f, input };
}

it.each([null, "https://provider.example.invalid/track?number=TRACK-a", "https://user:password@provider.example.invalid/track"])("passes a host-built query URL unchanged while applying provider rules to %s", async providerUrl => {
  const f = fixture(), value = observation();
  value.trackingRefs[0]!.publicUrl = providerUrl;
  const url = "https://tracking.example.invalid/track?number=TRACK-a";
  f.input.readPage = async () => [{ kind: "found", externalRef: "external-a", createdAt: null, updatedAt: null, observation: value }];
  f.input.lifecycle.trackingCodecs.publicUrl = () => url;
  f.input.lifecycle.trackingCodecs.approveTrackingUrl = () => true;
  const query = vi.fn(async () => ({ rows: [{ response: {
    contractVersion: "platform.fulfillment.shipment.v1", replayed: false,
    shipment: { id: "fulfillment-a", orderId: "order-a", status: "in_transit" },
  } }] }));
  const spine = createPostgresFulfillmentShipmentSpinePort({ query }, { portKey: "warehouse-a", evidenceChannel: "poll" });
  const recordTrackingReference = vi.fn(async (tracking: Parameters<typeof f.input.lifecycle.effects.recordTrackingReference>[0]) => {
    const result = await spine.recordTracking({ idempotencyKey: tracking.idempotencyKey, shipmentId: tracking.fulfillmentOrderId,
      externalRef: tracking.trackingNumber, status: tracking.status, metadata: { trackingUrl: tracking.trackingUrl } });
    return { replayed: result.replayed, readBack: false };
  });
  f.input.lifecycle.effects.recordTrackingReference = recordTrackingReference;
  const result = await run(f.input);
  expect(result).toMatchObject({ ok: true, trackingRefs: 1 });
  expect(result.redactedFieldCount).toBe(providerUrl ? 1 : undefined);
  expect(recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({ trackingUrl: url }));
  expect(query).toHaveBeenCalledWith(expect.stringContaining("fulfillment_record_evidence"), expect.arrayContaining([{ trackingUrl: url }]));
  expect(query).toHaveBeenCalledWith(expect.stringContaining("fulfillment_advance_shipment"), expect.arrayContaining([{ trackingUrl: url }]));
});

it("drops and counts distinct refused tracking numbers before reconciliation evidence, codecs and tracking effects", async () => {
  const f = fixture(), value = observation();
  value.trackingRefs = ["invalid number", "invalid/number"].map(trackingNumber => ({
    trackingNumber, carrierRef: null, serviceRef: null, publicUrl: null,
  }));
  f.input.readPage = async () => [{ kind: "found", externalRef: "external-a", createdAt: null, updatedAt: null, observation: value }];
  const recordTrackingReference = vi.spyOn(f.input.lifecycle.effects, "recordTrackingReference");
  const recordStatusEvidence = vi.spyOn(f.input.lifecycle, "recordStatusEvidence");
  const publicUrl = vi.spyOn(f.input.lifecycle.trackingCodecs, "publicUrl");
  expect(await run(f.input)).toMatchObject({ ok: true, trackingRefs: 0, redactedFieldCount: 2 });
  expect(recordStatusEvidence).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    trackingRefs: [], diagnostics: { redactedFieldCount: 2 },
  }));
  expect(recordTrackingReference).not.toHaveBeenCalled();
  expect(publicUrl).not.toHaveBeenCalled();
});

it("writes evidence only for locally cancelled created dispatches, and skips older shipped effects without moving or stacking alignment (G17)", async () => {
  const cancelled = fixture("cancelled");
  expect(await run(cancelled.input)).toMatchObject({ ok: true, offTrackSkips: 1, updated: 0, quarantined: 0 });
  expect(cancelled.trace).toEqual(["find", "status"]);
  const stale = fixture("delivered", "2026-10-21T12:00:00Z");
  let alignment = "2026-11-21T12:00:00Z", alignmentWrites = 0;
  stale.input.lifecycle.effects.markHandedOver = async () => { alignment = "2026-11-20T11:00:00Z"; alignmentWrites += 1; return { replayed: false }; };
  for (let attempt = 0; attempt < 2; attempt++) expect(await run(stale.input)).toMatchObject({ ok: true, stale: 1, updated: 0 });
  expect(stale.trace).toEqual(["find", "ack", "invoice", "find", "ack", "invoice"]);
  expect(alignment).toBe("2026-11-21T12:00:00Z"); expect(alignmentWrites).toBe(0);
  expect(stale.durableEffects).not.toContain("stock");
});

it("preserves timestamp validation, nullable chronology, lazy tracking selection and classified quarantine/invoice outcomes", async () => {
  for (const bad of [null, "2026-02-29T11:00:00Z", "2026-10-21T11:00:00", "2026-13-21T11:00:00Z", "2026-10-21T24:00:00Z"]) expect(normalizeReconciliationTimestamp(bad)).toBeNull();
  expect(normalizeReconciliationTimestamp("2024-02-29T11:00:00+02:00")).toBe("2024-02-29T11:00:00+02:00");
  const refs = uniqueTrackingReferences([{ trackingNumber: " A ", carrierRef: "provider", serviceRef: null, publicUrl: null },
    { trackingNumber: "A", carrierRef: "ignored", serviceRef: "ignored", publicUrl: "https://ignored.invalid" },
    { trackingNumber: "B", carrierRef: null, serviceRef: null, publicUrl: null }]);
  expect(refs.map(r => r.trackingNumber)).toEqual(["A", "B"]);
  const f = fixture();
  const a = enrichTrackingReference(refs[0], { carrierRef: "local", serviceRef: "local-service" }, f.input.lifecycle.trackingCodecs);
  expect(a).toMatchObject({ carrierRef: "provider", serviceRef: null });
  f.input.readPage = async () => [{ kind: "found", externalRef: "external-a", createdAt: null, updatedAt: null, observation: { ...observation(), trackingRefs: refs } }];
  f.input.lifecycle.issueAccountingInvoice = async () => { throw new Error("synthetic-private-detail"); };
  expect(await run(f.input)).toMatchObject({ ok: true, updated: 1, trackingRefs: 2, invoiceIssueRefused: 1, invoiceIssueFailures: 0,
    invoiceIssueRefusals: [{ fulfillmentRef: "fulfillment-a", identifier: "invoice_order_not_found", sqlstate: "22023", benign: true }] });
  expect(f.trace.filter(t => t === "carrier")).toHaveLength(1);
  expect(f.trace.indexOf("stock")).toBeLessThan(f.trace.indexOf("handoff:false"));
  const conflict = fixture();
  conflict.input.lifecycle.effects.markProviderStockConsumed = async () => { throw new Error("known local guard"); };
  conflict.input.lifecycle.classifyStateConflict = () => "stock_consumed_requires_label";
  expect(await run(conflict.input)).toMatchObject({ ok: true, stateConflicts: 1, quarantined: 1, failures: 0 });
  conflict.input.lifecycle.recordQuarantine = async () => { throw new Error("synthetic-private-quarantine"); };
  expect(await run(conflict.input)).toMatchObject({ ok: false, failures: 1, reason: "reconciliation_local_operation_failed" });
  const unmapped = fixture("cancelled");
  unmapped.input.readPage = async () => [{ kind: "unmapped", evidence: { correlation: observation().correlation, eventKey: "legacy:unmapped" }, externalRef: "external-a" }];
  expect(await run(unmapped.input)).toMatchObject({ offTrackSkips: 1, quarantined: 0 });
  expect(unmapped.trace).toEqual(["find"]);
  unmapped.input.localPersistence.readLocalFulfillmentStatus = async () => "label_created";
  expect(await run(unmapped.input)).toMatchObject({ quarantined: 1, offTrackSkips: 0 });
  expect(unmapped.trace.slice(-3)).toEqual(["find", "ack", "quarantine:unknown_status"]);
  const missing = fixture(); missing.input.lifecycle.findDispatchRef = async () => null;
  expect(await run(missing.input)).toMatchObject({ quarantined: 1, updated: 0 });
});


it("fails provider read uncertainty without local writes and projects unmapped evidence before every host call", async () => {
  const failed = fixture();
  failed.input.readPage = async () => [{ kind: "unknown", refusal: { reason: "io_failure", phase: "readback", retryable: true } }];
  expect(await run(failed.input)).toMatchObject({ ok: false, checked: 1, failures: 1, reason: "fulfillment_reconciliation_provider_read_failed" });
  expect(failed.trace).toEqual([]); expect(failed.durableEffects).toEqual([]);
  const unmapped = fixture();
  const correlation = { ...observation().correlation, privateField: "synthetic-private-detail" };
  const evidence = { correlation, eventKey: "legacy:unmapped", privateField: "synthetic-private-detail" };
  unmapped.input.readPage = async () => [{ kind: "unmapped", evidence, externalRef: "external-a" }];
  const seen: unknown[] = [];
  const find = unmapped.input.lifecycle.findDispatchRef;
  unmapped.input.lifecycle.findDispatchRef = async value => { seen.push(value); return find(value); };
  unmapped.input.lifecycle.acknowledgeDispatchAcceptance = async (_ref, value) => { seen.push(value); };
  unmapped.input.lifecycle.recordQuarantine = async value => { seen.push(value); return { replayed: false }; };
  expect(await run(unmapped.input)).toMatchObject({ ok: true, quarantined: 1 });
  expect(seen).toEqual(Array(3).fill({ correlation: observation().correlation, eventKey: "legacy:unmapped" }));
});
