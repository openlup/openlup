import type { DispatchRecord, FulfillmentCapabilityDescriptor, FulfillmentDispatchRequest, FulfillmentObservation, FulfillmentStorePort } from "../../src/fulfillment/contracts/index.js";
import type { verifyAndNormalizeFulfillmentObservation } from "../../src/fulfillment/verifiedIngress.js";

export const at = "2026-10-21T12:00:00.000Z";
export function observation(status: FulfillmentObservation["fact"]["canonicalStatus"] = "in_transit", occurredAt: string | null = at): FulfillmentObservation {
  const eventKind = status === "delivered" ? "order.delivered" : status === "packed" ? "order.picked" : status === "picking" ? "order.processing_started" : "order.shipped";
  return {
    fact: { schemaVersion: 1, mapperVersion: "fixture-v1", factId: `fact:${status}:${occurredAt}`, providerKind: "warehouse-a", fulfillmentReference: "external-a", canonicalStatus: status,
      provenance: { source: "provider_webhook", authority: "provider_asserted" }, occurredAt, receivedAt: at,
      rawEvent: { reference: "evidence:00000000-0000-4000-8000-000000000001", digestAlgorithm: "sha256", digest: "a".repeat(64) } },
    eventKind, eventKey: `legacy:${eventKind}:external-a:${occurredAt ?? "unknown-time"}`, firstReceivedAt: at,
    correlation: { orderRef: "order-a", fulfillmentRef: "fulfillment-a", externalRef: "external-a", orderNumber: null, providerFulfillmentRef: null, parcelRef: null },
    trackingRefs: [{ trackingNumber: "TRACK-a", carrierRef: "carrier-a", serviceRef: "service-a", publicUrl: "https://tracking.example.invalid/TRACK-a" }],
  };
}
export function request(revision = 1): FulfillmentDispatchRequest {
  return { requestKey: "legacy-request-a", fulfillmentRef: "fulfillment-a", orderRef: "order-a", orderNumber: null, parcelRef: null,
    contactRevision: { schemaVersion: 1, source: "contact", revision },
    recipient: { name: null, email: null, phone: null, line1: "Synthetic 1", line2: null, city: "Example", postalCode: "00000", country: "XX", deliveryInstructions: null, courierInstructions: null },
    lines: [{ skuRef: "sku-a", title: null, quantity: 1, productRef: null, packRef: null }],
    selection: { providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a", deliveryKind: "courier", pickupPoint: null } };
}
export function profile(full = true): FulfillmentCapabilityDescriptor {
  const support = { supported: true } as const, no = { supported: false, reason: "not_exposed" } as const;
  return { providerRef: "warehouse-a", role: "warehouse", defaultOff: true, selected: true, readiness: { ready: true },
    operations: { dispatch: support, readback: full ? support : no, exactAbsence: full ? support : no, verifyObservation: full ? support : no,
      syncStock: full ? support : no, syncProducts: full ? support : no, labelCreate: full ? support : no, labelRead: full ? support : no, labelVoid: full ? support : no,
      cancel: no, pickupPoint: no, courierPickup: no }, authentication: "token", freshness: "not_available", ownsDeliveredNotification: true,
    stockAuthority: "external_stock_master_with_local_reservations", labelReadOwner: full ? "adapter" : "none",
    actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: false, mutationSurface: "provider_adapter" } };
}
export function ingressFixture(initial = observation()) {
  type Input = Parameters<typeof verifyAndNormalizeFulfillmentObservation>[0];
  const trace: string[] = [], durableEffects: string[] = [], receipts = new Set<string>();
  const inbound = new Map<string, FulfillmentObservation>(), processed = new Map<string, unknown>();
  let current = initial, failStock = false, annotationFails = false;
  const stockBusy = new Error("synthetic stock lock");
  const once = (key: string, effect: string) => { const replayed = receipts.has(key); receipts.add(key); if (!replayed) durableEffects.push(effect); return { replayed }; };
  const input: Input = {
    enabled: true, verification: { rawBody: new TextEncoder().encode("synthetic-body"), headers: { authorization: "fixture-secret" }, receivedAt: at },
    provider: { async verifyAndNormalize(value) {
      trace.push("auth"); if (value.headers.authorization !== "fixture-secret") return { kind: "refused", refusal: { reason: "untrusted", phase: "verify", retryable: false } };
      trace.push("parse"); return { kind: "verified", observation: current };
    } },
    localPersistence: {
      async recordObservation(value) { trace.push("ingest"); const replayed = inbound.has(value.eventKey); if (!replayed) inbound.set(value.eventKey, structuredClone(value)); return { replayed }; },
      async markProcessed(key, value) { trace.push("processed"); if (!processed.has(key)) processed.set(key, value); },
    },
    lifecycle: {
      async findDispatchRef() { trace.push("find"); return { orderRef: "order-a", fulfillmentRef: "fulfillment-a", dispatchRef: "dispatch-created", externalRef: "external-a" }; },
      async acknowledgeDispatchAcceptance() { trace.push("ack"); once("acceptance", "acceptance"); },
      async recordStatusEvidence(_ref, value) { trace.push("status"); return once(value.eventKey, "status"); },
      effects: {
        async markProviderStockConsumed(value) { trace.push("stock"); if (failStock) throw stockBusy; return once(value.idempotencyKey, "stock"); },
        async markHandedOver(value) { trace.push(`handoff:${value.suppressDispatched}`); return once(value.idempotencyKey, "handoff"); },
        async recordTrackingReference(value) { trace.push("tracking"); return { ...once(value.idempotencyKey, "tracking"), readBack: false }; },
      },
      keys: { stock: ref => `legacy:${ref}:stock`, handoff: ref => `legacy:${ref}:handoff`, tracking: (key, number) => `legacy:${key}:${number}` },
      async issueAccountingInvoice() { trace.push("invoice"); once("invoice", "invoice"); },
      classifyFailure: error => error === stockBusy ? "stock_contention" : "other",
      async annotateStockContention(key) { trace.push("annotate"); if (annotationFails) throw new Error("synthetic annotation"); inbound.get(key)!.diagnostics = { stockContention: { sqlState: "55P03", phase: "provider_stock_consumed", retryable: true }, annotation: "recorded" }; },
    },
  };
  return { input, trace, durableEffects, inbound, processed, stockBusy,
    setObservation(value: FulfillmentObservation) { current = value; }, failStock(value: boolean) { failStock = value; }, failAnnotation(value: boolean) { annotationFails = value; } };
}
export function memoryStore(): FulfillmentStorePort & { readMappedAttempts(): Promise<readonly { attemptKey: string; fulfillmentRef: string; preparedEvidence: DispatchRecord["evidence"]; mode: DispatchRecord["mode"]; status: "recorded" }[]> } {
  let row: DispatchRecord | null = null;
  const attempts = new Map<string, { attemptKey: string; fulfillmentRef: string; preparedEvidence: DispatchRecord["evidence"]; mode: DispatchRecord["mode"]; status: "recorded" }>();
  return {
    async readMappedAttempts() { return structuredClone([...attempts.values()]); },
    async read() { return row && structuredClone(row); }, async readCandidate() { return request(); },
    async prepare() { return { disposition: "ready", contactRevision: 1 }; },
    async claim(input) {
      const replayed = row !== null;
      row = row && row.status !== "draft" ? row : { ...structuredClone(input), dispatchRef: "dispatch-a", externalRef: null, status: "draft", replayed };
      return { kind: "claimed", record: { ...structuredClone(row), replayed } };
    },
    async recordProviderAttempt(key, fulfillmentRef, preparedEvidence, mode, status) {
      const replayed = attempts.has(key); if (!replayed) attempts.set(key, { attemptKey: key, fulfillmentRef, preparedEvidence: structuredClone(preparedEvidence), mode, status }); return { replayed };
    },
    async begin(input) {
      if (row!.evidence.commandFingerprint !== input.commandFingerprint) return { kind: "refused", refusal: { reason: "contact_stale", phase: "begin", retryable: true } };
      const begun = row!.status === "draft"; row!.status = "submitting";
      return { kind: "begun", record: structuredClone(row!), begun, replayed: !begun };
    },
    async finalize(input) { row!.status = "uncertain"; if (input.result.kind === "accepted") row!.externalRef = input.result.externalRef; return structuredClone(row!); },
    async acknowledge(input) { row!.status = "created"; row!.externalRef = input.acceptance.externalRef; return { record: structuredClone(row!), replayed: false, acknowledged: true }; },
    async markStaleSubmissionsUncertain() { return 0; },
  };
}
