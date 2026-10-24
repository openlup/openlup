import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runFulfillmentAdapterConformance, runFulfillmentDispatchWorker } from "../../../src/fulfillment/index.js";
import { createOmnipackFulfillmentAdapter } from "../../../src/fulfillment/omnipack/index.js";
import type { DispatchEvidence, DispatchRecord, FulfillmentStorePort, FulfillmentAdapterConformanceSubject as Subject, FulfillmentDispatchRequest, FulfillmentObservation, FulfillmentRefusal } from "../../../src/fulfillment/contracts/index.js";

const now = "2026-10-21T10:00:00.000Z";
const email = "synthetic-recipient@example.test", phone = "+12025550123", credential = "synthetic-credential-placeholder";
const signedUrl = "https://tracking.example.test/a?signature=synthetic-signature-placeholder";
const evidenceRef = "evidence:00000000-0000-4000-8000-000000000001" as const;
const plants = { email, phone, credential, signedUrl };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const refusal = (reason: FulfillmentRefusal["reason"], phase: FulfillmentRefusal["phase"]): FulfillmentRefusal => ({ reason, phase, retryable: false });
function request(): FulfillmentDispatchRequest {
  return { requestKey: "request-a", fulfillmentRef: "fulfillment-a", orderRef: "order-a", orderNumber: "ORDER-A", parcelRef: null,
    contactRevision: { schemaVersion: 1, source: "checkout", revision: 3 },
    recipient: { name: "Example Recipient", email, phone, line1: "123 Example Street", line2: null,
      city: "Example City", postalCode: "10001", country: "US", deliveryInstructions: null, courierInstructions: null },
    lines: [{ skuRef: "SKU-A", quantity: 2, title: null, productRef: null, packRef: null }],
    selection: { providerRef: "omnipack", carrierRef: "CARRIER-A", serviceRef: "SERVICE-A", deliveryKind: "courier", pickupPoint: null } };
}
// Independently specified wire bytes (sorted keys), rather than adapter-produced expectations.
const commandBody = JSON.stringify({
  items: [{ expirationDate: "2027-01-01", lotNumber: "LOT-A", quantity: 2, sku: "SKU-A" }], orderNumber: "ORDER-A",
  shippingDetails: { address: { city: "Example City", country: "US", email, name: "Example Recipient", phone, postCode: "10001", street: "123 Example Street" }, carrier: "SERVICE-A", service: "SERVICE-A" },
});
const preparedEvidence: DispatchEvidence = { commandFingerprint: hash(commandBody), contactRevision: request().contactRevision,
  providerRef: "omnipack", carrierRef: "CARRIER-A", serviceRef: "SERVICE-A",
  transcript: { itemCount: 1, items: [{ skuRef: "SKU-A", quantity: 2, lotRef: "LOT-A", expirationDate: "2027-01-01" }], deliveryKind: "courier", pickupPointRef: null } };
// Independently derived opaque provider proof keys; the worker supplies host keys.
const accepted = { kind: "accepted" as const, externalRef: "external-a", evidence: preparedEvidence, providerAttemptKey: `attempt:${hash(JSON.stringify(["external-a", preparedEvidence.commandFingerprint]))}`, labelKey: `label:${hash(JSON.stringify(["external-a", preparedEvidence.commandFingerprint]))}` };
const webhookPayload = { event: "order.delivered", orderId: "external-a", fulfilmentNumber: "parcel-a", occurredAt: now,
  shipments: [{ trackingNo: "TRACK-A", trackingUrl: signedUrl }], ...plants };
const webhook = (body: unknown) => ({ rawBody: Buffer.from(JSON.stringify(body)), headers: { authorization: `Bearer ${credential}` }, receivedAt: now });
const trackingRefs = [{ trackingNumber: "TRACK-A", carrierRef: null, serviceRef: null, publicUrl: null }];
function expectedObservation(source: "provider_webhook" | "provider_reconciliation", raw: string | Uint8Array): FulfillmentObservation {
  const eventKey = source === "provider_webhook" ? `order.delivered:external-a:parcel-a:${now}`
    : hash(JSON.stringify(["external-a", "parcel-a", null, "delivered", null, now]));
  return { ...(source === "provider_reconciliation" ? { providerStatus: { primary: "delivered", subStatus: null } } : {}), fact: { schemaVersion: 1, mapperVersion: "1", factId: source === "provider_webhook" ? hash(eventKey) : eventKey, providerKind: "omnipack",
    fulfillmentReference: source === "provider_webhook" ? "parcel-a" : "fulfillment-a", canonicalStatus: "delivered",
    provenance: { source, authority: "provider_asserted" }, occurredAt: now, receivedAt: now,
    rawEvent: { reference: evidenceRef, digestAlgorithm: "sha256", digest: hash(raw) } },
    eventKind: "order.delivered", eventKey, firstReceivedAt: now,
    correlation: { orderRef: null, fulfillmentRef: source === "provider_webhook" ? null : "fulfillment-a",
      externalRef: "external-a", orderNumber: null, providerFulfillmentRef: "parcel-a", parcelRef: null }, trackingRefs, diagnostics: { redactedFieldCount: 1, admission: { rejectedTrackingRefs: 0, rejectedTrackingUrls: 1 } } };
}
const readInput = (externalRef: string) => ({ providerRef: "omnipack", requestKey: "request-a", fulfillmentRef: "fulfillment-a", externalRef, mode: "command" as const });
const readbackRawEvidence = { provider: "omnipack", event: "order.delivered", providerOrderId: "external-a", orderNumber: null,
  fulfilmentNumber: "parcel-a", occurredAt: now, trackingNumbers: ["TRACK-A"],
  trackingReferences: [{ provider: "omnipack", trackingNumber: "TRACK-A", trackingUrl: signedUrl, carrier: null, carrierKind: null, service: null }], shippingMethods: [] };
const syncIdentity = { providerRef: "omnipack", syncRunId: "sync-a", collectedAt: now, sourceRevision: null, revisionSource: "collection" as const };

function subject(): { value: Subject; calls: { method: string; path: string; body: BodyInit | null | undefined }[] } {
  const calls: { method: string; path: string; body: BodyInit | null | undefined }[] = [];
  let readbacks = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(url.toString()).pathname, method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body });
    let body: unknown;
    if (path === "/orders" && method === "POST") body = { orderId: "external-a", ...plants };
    else if (path === "/fulfilments" && method === "GET") body = { _embedded: { fulfilments: readbacks++ === 0 ? [{
      orderId: "external-a", fulfilmentNumber: "parcel-a", status: "delivered", updatedAt: now,
      shipments: [{ trackingNo: "TRACK-A", trackingUrl: signedUrl }], ...plants,
    }] : [] }, page: { number: 0, size: 100, totalPages: 1, totalElements: readbacks === 1 ? 1 : 0 }, ...plants };
    else if (path === "/stock" && method === "GET") body = { _embedded: { stockItems: [{ sku: "SKU-A", totalQuantity: 5, forSaleQuantity: 3, faultyQuantity: 2, ...plants }] }, ...plants };
    else if (path === "/stock-movements" && method === "GET") body = { _embedded: [{ sku: "SKU-A", quantity: -2, occurredAt: now,
      operationType: "order_shipped", warehouseDocumentNumber: "DOC-A", productLotNumber: "LOT-A", expirationDate: "2027-01-01", ...plants }] };
    else if (path === "/products/SKU-A" && method === "GET") body = { sku: "SKU-A", packs: [{ ean: "0000000000012", quantity: 2 }], ...plants };
    else throw Error(`Unexpected fake HTTP operation: ${method} ${path}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const adapter = createOmnipackFulfillmentAdapter({
    http: { baseUrl: "https://warehouse.example.test", credentials: () => ({ username: "synthetic", password: credential }),
      fetchImpl, timeoutMs: 1000, safeReadRetries: 0, productPath: "/products" }, selected: true, readiness: { ready: true },
    resolveProduct: async () => ({ lotNumber: "LOT-A", expirationDate: "2027-01-01" }),
    notification: { token: () => credential, expectedEvent: "order.delivered" }, clock: () => now,
    mintEvidenceReference: () => evidenceRef, mintSyncRunId: () => "sync-a", approveTrackingUrl: () => true,
  });
  const input = request();
  const refusedInput = { ...request(), lines: [] };
  const value: Subject = { subjectId: "omnipack-offline", adapter,
    readIoCount: () => calls.length, sensitiveValues: [email, phone, credential, signedUrl, "synthetic-signature-placeholder"],
    fixtures: {
      dispatch: [
        { input, expectedPrepare: { kind: "prepared", evidence: preparedEvidence }, expectedDispatch: accepted, replay: true },
        { input: refusedInput, expectedPrepare: { kind: "refused", refusal: refusal("not_dispatchable", "prepare") } },
      ],
      label: {
        create: [{ input: [input], expected: { kind: "refused", refusal: refusal("unsupported", "dispatch") } }],
        void: [{ input: [{ parcelRef: "parcel-a", document: null }], expected: { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: false, refusal: refusal("unsupported", "dispatch") } }],
      },
      observation: [
        { input: [webhook(webhookPayload)], expected: { kind: "verified", observation: expectedObservation("provider_webhook", webhook(webhookPayload).rawBody) } },
        { input: [webhook({ ...webhookPayload, event: "future.delivered" })], expected: { kind: "refused", refusal: refusal("unsupported_event", "normalize") } },
      ],
      readback: [
        { input: [readInput("external-a")], expected: { kind: "found", externalRef: "external-a", createdAt: null, updatedAt: now,
          observation: expectedObservation("provider_reconciliation", JSON.stringify({ ...readbackRawEvidence, providerStatus: { primary: "delivered", subStatus: null } })) } },
        { input: [readInput("external-missing")], expected: { kind: "unknown", refusal: refusal("local_missing", "readback") }, localMissing: true },
      ],
      stockSync: [
        { operation: "getStock", input: [], expected: [{ ...syncIdentity, skuRef: "SKU-A", quantityKind: "snapshot", totalQuantity: 5, forSaleQuantity: 3, reservedOrUnavailableQuantity: 2 }] },
        { operation: "getStockMovements", input: [{ size: 1 }], expected: [{ ...syncIdentity, skuRef: "SKU-A", quantityKind: "movement", quantity: -2,
          occurredAt: now, operationType: "order_shipped", documentRef: "DOC-A", lotRef: "LOT-A", expirationDate: "2027-01-01" }] },
      ],
      productSync: [
        { operation: "getProductPacks", input: ["SKU-A"], expected: [{ ean: "0000000000012", quantity: 2 }] },
        { operation: "listStockedSkus", input: [], expected: ["SKU-A"] },
      ],
    } };
  return { value, calls };
}

it("passes M08 offline conformance with replay, refusals and redacted provider evidence", async () => {
  const fixture = subject();
  const result = await runFulfillmentAdapterConformance([fixture.value]);
  expect(result.subjects).toEqual([{ subjectId: "omnipack-offline", providerRef: "omnipack" }]);
  expect(result.cases).toEqual([
    "default-off and selection_required",
    "dispatch accepted, fingerprint, mismatch and replay",
    "dispatch refused before I/O",
    "label create", "label void",
    "observation identity, replay and redaction", "observation identity, replay and redaction",
    "readback found", "readback unknown",
    "stockSync getStock", "stockSync getStockMovements",
    "productSync getProductPacks", "productSync listStockedSkus",
  ].map(operation => ({ subjectId: "omnipack-offline", operation, passed: true })));
  expect(fixture.calls.map(call => call.method)).toEqual(["POST", ...Array(6).fill("GET")]);
  expect(fixture.calls[0].body).toBe(commandBody);
  for (const sensitive of fixture.value.sensitiveValues) expect(JSON.stringify(result)).not.toContain(sensitive);
});

it("M08 host ledger fences fresh-instance and evicted-fingerprint replays before provider I/O", async () => {
  for (const scenario of ["restart", "eviction"] as const) {
    const candidate = request();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ orderId: "external-a" }), { status: 200 }));
    const credentials = vi.fn(() => ({ username: "synthetic", password: credential }));
    let lotNumber = "LOT-A";
    const resolveProduct = vi.fn(async () => ({ lotNumber, expirationDate: "2027-01-01" }));
    const makeAdapter = () => createOmnipackFulfillmentAdapter({
      http: { baseUrl: "https://warehouse.example.test", credentials, fetchImpl, timeoutMs: 1000, safeReadRetries: 0, productPath: "/products" },
      selected: true, readiness: { ready: true }, maxRetainedSubmissions: 1,
      resolveProduct,
      notification: { token: () => credential, expectedEvent: "order.delivered" }, clock: () => now,
      mintEvidenceReference: () => evidenceRef, mintSyncRunId: () => "sync-a", approveTrackingUrl: () => false,
    });
    const previous = makeAdapter();
    const preparation = await previous.dispatch.prepare(candidate);
    expect(preparation).toEqual({ kind: "prepared", evidence: preparedEvidence });
    if (preparation.kind !== "prepared") throw Error("Expected prior command evidence");
    if (scenario === "eviction") {
      expect(await previous.dispatch.dispatch(candidate, preparation.evidence)).toEqual(accepted);
      const other = { ...candidate, requestKey: "request-b", orderNumber: "ORDER-B" };
      const next = await previous.dispatch.prepare(other);
      if (next.kind !== "prepared") throw Error("Expected eviction command evidence");
      expect(next.evidence.commandFingerprint).not.toBe(preparation.evidence.commandFingerprint);
      expect(await previous.dispatch.dispatch(other, next.evidence)).toMatchObject({ kind: "accepted" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // A retained result would replay acceptance without resolving metadata.
      // Drift refuses here only because the original fingerprint was evicted.
      lotNumber = "LOT-DRIFT";
      resolveProduct.mockClear();
      expect(await previous.dispatch.dispatch(candidate, preparation.evidence)).toEqual({
        kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: refusal("not_dispatchable", "dispatch"),
      });
      expect(resolveProduct).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      lotNumber = "LOT-A";
    }
    // Durable host state after claim/recordProviderAttempt/begin, before acceptance.
    const record: DispatchRecord = { dispatchRef: "dispatch-a", requestKey: candidate.requestKey, fulfillmentRef: candidate.fulfillmentRef,
      orderRef: candidate.orderRef, parcelRef: null, mode: "stage", externalRef: null, status: "submitting",
      evidence: { ...preparation.evidence, mapping: { source: "dispatch_worker", mode: "stage", shadowMode: false } }, replayed: true };
    const ledger = new Map([[candidate.requestKey, structuredClone(record)]]);
    const attempts = new Map([["mapped-a", structuredClone(record.evidence)]]);
    const store: FulfillmentStorePort = {
      markStaleSubmissionsUncertain: vi.fn(async () => 0),
      async read(key) { return structuredClone(ledger.get(key) ?? null); },
      async prepare(ref) { expect(ref).toBe(candidate.fulfillmentRef); return { disposition: "ready", contactRevision: 3 }; },
      async readCandidate(ref) { expect(ref).toBe(candidate.fulfillmentRef); return structuredClone(candidate); },
      claim: vi.fn<FulfillmentStorePort["claim"]>(async input => {
        expect(input.evidence).toEqual(record.evidence);
        const existing = ledger.get(input.requestKey);
        if (!existing) throw Error("Missing persisted dispatch");
        return { kind: "claimed", record: structuredClone(existing) };
      }),
      recordProviderAttempt: vi.fn<FulfillmentStorePort["recordProviderAttempt"]>(async (key, ref, evidence, mode, status) => {
        expect([key, ref, mode, status]).toEqual(["mapped-a", candidate.fulfillmentRef, "stage", "recorded"]);
        expect(attempts.get(key)).toEqual(evidence);
        return { replayed: true };
      }),
      begin: vi.fn(async () => { throw Error("Already begun"); }),
      finalize: vi.fn(async () => { throw Error("Must preserve uncertain obligation"); }),
      acknowledge: vi.fn(async () => { throw Error("No acceptance proof"); }),
    };
    const adapter = scenario === "restart" ? makeAdapter() : previous;
    const dispatch = vi.spyOn(adapter.dispatch, "dispatch");
    fetchImpl.mockClear(); credentials.mockClear();
    const result = await runFulfillmentDispatchWorker({ store, provider: adapter.dispatch,
      listCandidates: async () => [structuredClone(candidate)], keys: { request: () => candidate.requestKey,
        mappedAttempt: () => "mapped-a", acceptance: () => ({ providerAttemptKey: "host-attempt-a", labelKey: "host-label-a" }) },
      config: { mode: "stage", batchLimit: 1 }, now: () => new Date(now) });
    expect(result, scenario).toMatchObject({ ok: false, checked: 1, updated: 0, failures: 1, providerCalls: 0, reason: "dispatch_not_safe_to_submit:submitting" });
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(store.recordProviderAttempt).toHaveBeenCalledTimes(1);
    for (const operation of [dispatch, credentials, fetchImpl, store.begin, store.finalize, store.acknowledge]) expect(operation, scenario).not.toHaveBeenCalled();
    expect(ledger.get(candidate.requestKey)).toEqual(record);
    expect(attempts.size).toBe(1);
  }
});
