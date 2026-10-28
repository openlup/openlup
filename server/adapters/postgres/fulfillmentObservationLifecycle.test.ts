import { expect, it, vi } from "vitest";
import type { DispatchRecord, FulfillmentObservation } from "@openlup/platform/fulfillment/contracts";
import { createPostgresFulfillmentObservationLifecycle } from "./fulfillmentObservationLifecycle.js";

const shipment = "00000000-0000-4000-8000-000000000001";
const order = "00000000-0000-4000-8000-000000000002";
const dispatch = "00000000-0000-4000-8000-000000000003";
const keys = { providerAttemptKey: "accepted:shipment", labelKey: "receipt:shipment" };
const evidence = { commandFingerprint: "a".repeat(64), contactRevision: { schemaVersion: 1, source: "native", revision: 1 },
  providerRef: "synthetic", carrierRef: null, serviceRef: null };
const record = (): DispatchRecord => ({ dispatchRef: dispatch, requestKey: "dispatch:shipment", fulfillmentRef: shipment,
  orderRef: order, parcelRef: null, externalRef: null, status: "submitting", mode: "live", evidence, replayed: false });
const observation = (): FulfillmentObservation => ({
  fact: { schemaVersion: 1, mapperVersion: "synthetic-v1", factId: "accepted:one", providerKind: "synthetic",
    fulfillmentReference: "external:random", canonicalStatus: "provider_received", provenance: { source: "provider_webhook", authority: "provider_asserted" },
    occurredAt: "2026-10-27T12:00:00Z", receivedAt: "2026-10-27T12:01:00Z",
    rawEvent: { reference: "evidence:one", digestAlgorithm: "sha256", digest: "b".repeat(64) } },
  eventKind: "shipment.accepted", eventKey: "accepted:one", firstReceivedAt: "2026-10-27T12:01:00Z",
  correlation: { fulfillmentRef: shipment, orderRef: order, externalRef: "external:random", orderNumber: null, providerFulfillmentRef: null, parcelRef: null },
  trackingRefs: [],
});
function fixture(rows: DispatchRecord[] = [record()]) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => sql.includes("fulfillment_dispatch_finish")
    ? { rows: [{ response: { acknowledged: true, record: { ...record(), status: "created", externalRef: "external:random" } } }] }
    : { rows: rows.map(response => ({ response })) });
  const lifecycle = createPostgresFulfillmentObservationLifecycle({ query }, { providerRef: "synthetic", acceptanceKeys: () => keys });
  return { query, lifecycle };
}

it("recovers an unknown provider ID from exact shipment correlation using only the existing atomic ACK", async () => {
  const { query, lifecycle } = fixture();
  const ref = await lifecycle.findDispatchRef(observation());
  expect(ref).toEqual({ dispatchRef: dispatch, fulfillmentRef: shipment, orderRef: order, externalRef: null });
  await lifecycle.acknowledgeDispatchAcceptance(ref!, observation());
  expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls[0][1]).toEqual([shipment, "synthetic"]);
  expect(JSON.parse(query.mock.calls[2][1]![1] as string)).toEqual({ kind: "accepted", externalRef: "external:random", evidence, ...keys });
});

it("does not guess a shipment from a merchant number or a missing native identity", async () => {
  const { query, lifecycle } = fixture();
  const input = observation(); input.correlation.fulfillmentRef = null; input.correlation.orderNumber = "merchant:one";
  await expect(lifecycle.findDispatchRef(input)).resolves.toBeNull();
  input.correlation.fulfillmentRef = "invalid-uuid";
  await expect(lifecycle.findDispatchRef(input)).resolves.toBeNull();
  expect(query).not.toHaveBeenCalled();
});

it("refuses a different provider before a database call", async () => {
  const { query, lifecycle } = fixture(); const input = observation(); input.fact = { ...input.fact, providerKind: "other" };
  await expect(lifecycle.findDispatchRef(input)).rejects.toThrow("provider_mismatch");
  expect(query).not.toHaveBeenCalled();
});

it.each(["order", "external", "parcel", "ambiguous", "shadow"])("refuses conflicting %s correlation before ACK", async kind => {
  const row = record();
  if (kind === "order") row.orderRef = "different";
  if (kind === "external") row.externalRef = "external:other";
  if (kind === "parcel") row.parcelRef = "parcel:one";
  if (kind === "shadow") row.mode = "shadow";
  const { query, lifecycle } = fixture(kind === "ambiguous" ? [row, row] : [row]);
  const input = observation(); if (kind === "parcel") input.correlation.parcelRef = "parcel:other";
  await expect(lifecycle.findDispatchRef(input)).rejects.toThrow("correlation_conflict");
  expect(query).toHaveBeenCalledTimes(1);
});

it("retains the exact committed acceptance on late-observation replay", async () => {
  const row = record(); row.status = "created"; row.externalRef = "external:random";
  row.acceptance = { kind: "accepted", externalRef: row.externalRef, evidence, ...keys,
    recovery: { source: "persisted_acceptance", proof: "persisted_external_ref", noProviderPost: true } };
  const { query, lifecycle } = fixture([row]);
  const ref = await lifecycle.findDispatchRef(observation());
  await lifecycle.acknowledgeDispatchAcceptance(ref!, observation());
  expect(JSON.parse(query.mock.calls[2][1]![1] as string)).toEqual(row.acceptance);
});

it("reads current state again and rejects a changed dispatch instead of trusting a prior lookup", async () => {
  const { query, lifecycle } = fixture(); const ref = await lifecycle.findDispatchRef(observation());
  query.mockResolvedValueOnce({ rows: [{ response: { ...record(), dispatchRef: "different" } }] });
  await expect(lifecycle.acknowledgeDispatchAcceptance(ref!, observation())).rejects.toThrow("dispatch_changed");
  expect(query).toHaveBeenCalledTimes(2);
});

it("propagates native refusal without retrying or creating a provider effect", async () => {
  const { query, lifecycle } = fixture(); const ref = await lifecycle.findDispatchRef(observation());
  query.mockResolvedValueOnce({ rows: [{ response: record() }] });
  query.mockRejectedValueOnce(Object.assign(new Error("fulfillment_dispatch_acceptance_conflict"), { code: "23505" }));
  await expect(lifecycle.acknowledgeDispatchAcceptance(ref!, observation())).rejects.toMatchObject({ code: "23505" });
  expect(query).toHaveBeenCalledTimes(3);
});
