import { createHash } from "node:crypto";
import { expect, expectTypeOf, it, vi } from "vitest";
import { runFulfillmentAdapterConformance, runFulfillmentDispatchWorker } from "../../../src/fulfillment/index.js";
import { createScriptedFulfillmentFake } from "../../../src/fulfillment/testing/index.js";
import type { FulfillmentAdapterTestSubject } from "../../../src/fulfillment/testing/index.js";
import * as capabilityReader from "../../../src/fulfillment/providerCapabilities.js";
import { PORTLESS_CAPABILITIES } from "../../../src/fulfillment/testing/schema.js";
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

function subject(options: { fetchImpl?: typeof fetch; credentials?: () => Promise<{ username: string; password: string }>; readIoCount?: () => number; product?: { resolvePushMetadata: (sku: string) => Promise<Record<string, unknown> | null> } } = {}): { value: Subject; calls: { method: string; path: string; body: BodyInit | null | undefined }[] } {
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
    http: { baseUrl: "https://warehouse.example.test", credentials: options.credentials ?? (() => ({ username: "synthetic", password: credential })),
      fetchImpl: options.fetchImpl ?? fetchImpl, timeoutMs: 1000, safeReadRetries: 0, productPath: "/products" }, selected: true, readiness: { ready: true },
    resolveProduct: async () => ({ lotNumber: "LOT-A", expirationDate: "2027-01-01" }),
    notification: { token: () => credential, expectedEvent: "order.delivered" }, clock: () => now,
    mintEvidenceReference: () => evidenceRef, mintSyncRunId: () => "sync-a", approveTrackingUrl: () => true, product: options.product,
  });
  const input = request();
  const refusedInput = { ...request(), lines: [] };
  const value: Subject = { subjectId: "omnipack-offline", adapter,
    readIoCount: options.readIoCount ?? (() => calls.length), sensitiveValues: [email, phone, credential, signedUrl, "synthetic-signature-placeholder"],
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

function fullSubject() {
  const fake = createScriptedFulfillmentFake<Record<string, Response>>();
  const json = (body: unknown, status = 200) => ({ kind: "success" as const, value: new Response(JSON.stringify(body), { status }) });
  const response = (rows: unknown[]) => ({ _embedded: { fulfilments: rows }, page: { number: 0, size: 100, totalPages: 1, totalElements: rows.length } });
  const delivered = { orderId: "external-a", fulfilmentNumber: "parcel-a", status: "delivered", updatedAt: now, shipments: [{ trackingNo: "TRACK-A", trackingUrl: signedUrl }] };
  let posts = 0, beforeSubmission = false, httpCalls = 0;
  const wire: { method: string; path: string; query: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    httpCalls += 1;
    const u = new URL(url.toString()), method = init?.method ?? "GET";
    wire.push({ method, path: u.pathname, query: u.search });
    // The next fixture fails in credentials, before the actual fetch boundary.
    if (method === "POST" && ++posts === 2) beforeSubmission = true;
    return fake.invoke(`${method} ${u.pathname}`);
  };
  fake.enqueue("POST /orders", json({ orderId: "external-a" }), { kind: "http-failure", status: 400, response: new Response("{}", { status: 400 }) },
    { kind: "transport-after-submission" }, { kind: "http-failure", status: 503, response: new Response("{}", { status: 503 }) });
  fake.enqueue("credentials", { kind: "transport-before-submission" });
  const value: FulfillmentAdapterTestSubject = subject({ fetchImpl, readIoCount: () => httpCalls,
    credentials: async () => { if (beforeSubmission) { beforeSubmission = false; await fake.invoke("credentials"); } return { username: "synthetic", password: credential }; },
    product: { resolvePushMetadata: async () => ({ sku: "SKU-A" }) } }).value;
  const dispatchRows = [...value.fixtures.dispatch];
  const dispatchError = (code: string, status: number | null, attempted: boolean) => ({ code, status, retryable: false, mayHaveSucceeded: attempted && status !== 400,
    submissionAttempted: attempted, ...(status === null ? {} : { responseBodyRead: true }) });
  for (const [key, detail] of [
    ["address-rejected", dispatchError("http_400", 400, true)],
    ["before-send", dispatchError("network_error", null, false)],
    ["after-send", dispatchError("network_error", null, true)],
    ["server-failure", dispatchError("http_503", 503, true)],
  ] as const) {
    const input = { ...request(), requestKey: key, orderNumber: key };
    const evidence = { ...preparedEvidence, commandFingerprint: hash(commandBody.replace('"ORDER-A"', JSON.stringify(key))) };
    dispatchRows.push({ input, expectedPrepare: { kind: "prepared", evidence }, replay: true,
      expectedDispatch: detail.mayHaveSucceeded ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: false }, error: detail }
        : { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "io_failure", phase: "dispatch", retryable: false }, error: detail } });
  }
  dispatchRows.push({ input: { ...request(), recipient: { ...request().recipient, line1: "" } },
    expectedPrepare: { kind: "refused", refusal: refusal("not_dispatchable", "prepare") } });
  const locker = { ...request(), requestKey: "locker", orderNumber: "LOCKER", selection: { ...request().selection, deliveryKind: "parcel-locker" as const, pickupPoint: { id: "POINT-A", provider: "point-provider", name: "Point", address: { line1: "Example", city: "Example", postalCode: "10001", country: "US" } } } };
  const lockerBody = commandBody.replace('"ORDER-A"', '"LOCKER"').replace('"service":"SERVICE-A"', '"pickUpPoint":"POINT-A","service":"SERVICE-A"');
  const lockerEvidence = { ...preparedEvidence, commandFingerprint: hash(lockerBody), transcript: { ...preparedEvidence.transcript!, deliveryKind: "parcel-locker" as const, pickupPointRef: "POINT-A" } };
  const lockerHash = hash(JSON.stringify(["external-locker", lockerEvidence.commandFingerprint]));
  dispatchRows.push({ input: locker, expectedPrepare: { kind: "prepared", evidence: lockerEvidence }, expectedDispatch: { kind: "accepted", externalRef: "external-locker", evidence: lockerEvidence, providerAttemptKey: `attempt:${lockerHash}`, labelKey: `label:${lockerHash}` } },
    { input: { ...locker, selection: { ...locker.selection, pickupPoint: null } }, expectedPrepare: { kind: "refused", refusal: refusal("not_dispatchable", "prepare") } });
  fake.enqueue("POST /orders", json({ orderId: "external-locker" }));
  value.fixtures.dispatch = dispatchRows;
  value.fixtures.label!.read = [{ input: [{ objectRef: "label-a", mediaType: "application/pdf", externalRef: "external-a" }], expected: { kind: "refused", refusal: refusal("unsupported", "dispatch") } }];
  const valid = value.fixtures.observation![0]!;
  const olderPayload = { ...webhookPayload, occurredAt: "2026-10-20T10:00:00.000Z" };
  const olderKey = `order.delivered:external-a:parcel-a:${olderPayload.occurredAt}`;
  const baseObservation = expectedObservation("provider_webhook", webhook(webhookPayload).rawBody);
  value.fixtures.observation = [valid, valid,
    { input: [webhook(olderPayload)], expected: { kind: "verified", observation: { ...baseObservation, eventKey: olderKey,
      fact: { ...baseObservation.fact, factId: hash(olderKey), occurredAt: olderPayload.occurredAt,
        rawEvent: { ...baseObservation.fact.rawEvent, digest: hash(webhook(olderPayload).rawBody) } } } } },
    { input: [{ ...webhook(webhookPayload), headers: { authorization: "Bearer incorrect-placeholder" } }], expected: { kind: "refused", refusal: refusal("untrusted", "verify") } }, valid];
  const readbacks = [...value.fixtures.readback!];
  // Independent expected coarse exception envelopes, without inventing a LOST status.
  const exception = (primary: string, detail: string | null) => {
    const providerStatus = { primary, subStatus: detail };
    const eventKey = hash(JSON.stringify(["external-a", "parcel-a", null, primary, detail, now]));
    const raw = { ...readbackRawEvidence, event: "parcel.exception", providerStatus };
    const observation: FulfillmentObservation = { ...expectedObservation("provider_reconciliation", JSON.stringify(raw)), providerStatus, eventKey, eventKind: "parcel.exception",
      fact: { ...expectedObservation("provider_reconciliation", JSON.stringify(raw)).fact, factId: eventKey, canonicalStatus: "exception" } };
    return { kind: "found" as const, externalRef: "external-a", createdAt: null, updatedAt: now, observation };
  };
  for (const [status, subStatus] of [["returned_to_sender", null], ["shipping_failed", "PARCEL_UNLOCATED"]] as const) {
    readbacks.push({ input: [readInput("external-a")], expected: exception(status, subStatus) });
  }
  fake.enqueue("GET /fulfilments", json(response([delivered])), json(response([])),
    json(response([{ ...delivered, status: "returned_to_sender" }])), json(response([{ ...delivered, status: "shipping_failed", subStatus: "PARCEL_UNLOCATED" }])));
  value.fixtures.readback = readbacks;
  // Empty baseline stock/movement and product calls retain the original exact fixtures.
  fake.enqueue("GET /stock", json({ _embedded: { stockItems: [{ sku: "SKU-A", totalQuantity: 5, forSaleQuantity: 3, faultyQuantity: 2 }] } }),
    json({ _embedded: { stockItems: [{ sku: "SKU-A" }] } }));
  fake.enqueue("GET /stock-movements", json({ _embedded: [{ sku: "SKU-A", quantity: -2, occurredAt: now, operationType: "order_shipped", warehouseDocumentNumber: "DOC-A", productLotNumber: "LOT-A", expirationDate: "2027-01-01" }] }));
  fake.enqueue("GET /products/SKU-A", json({ packs: [{ ean: "0000000000012", quantity: 2 }] }));
  // Numbered paging: full, short, empty, exhausted, HTTP failure.
  const pageRow = { ...delivered, shipments: [] };
  const pageObservation = expectedObservation("provider_reconciliation", "unused");
  const pageKey = hash(JSON.stringify(["external-a", "parcel-a", null, "delivered", null, now]));
  const pageRaw = { ...readbackRawEvidence, trackingNumbers: [], trackingReferences: [], providerStatus: { primary: "delivered", subStatus: null } };
  const pageResult = { kind: "found" as const, externalRef: "external-a", createdAt: null, updatedAt: now, observation: {
    ...pageObservation, trackingRefs: [], correlation: { ...pageObservation.correlation, fulfillmentRef: null },
    diagnostics: { admission: { rejectedTrackingRefs: 0, rejectedTrackingUrls: 0 } },
    fact: { ...pageObservation.fact, factId: pageKey, fulfillmentReference: "parcel-a", rawEvent: { ...pageObservation.fact.rawEvent, digest: hash(JSON.stringify(pageRaw)) } },
  } };
  fake.enqueue("GET /fulfilments", json(response([pageRow, pageRow])), json(response([pageRow])), json(response([])),
    { kind: "http-failure", status: 400, response: new Response(JSON.stringify({ code: "ERR_PAGE_MUST_BE_LESS_THAN_TOTAL_PAGES" }), { status: 400 }) },
    { kind: "http-failure", status: 503, response: new Response("{}", { status: 503 }) });
  const syncFailure = { reason: "io_failure" as const, phase: "sync" as const, retryable: false };
  const fail = () => ({ kind: "http-failure" as const, status: 503, response: new Response("{}", { status: 503 }) });
  fake.enqueue("GET /stock", json({ _embedded: { stockItems: [{ sku: "SKU-A", totalQuantity: 5, forSaleQuantity: 3, faultyQuantity: 2 }] } }), fail(),
    json({ _embedded: { stockItems: [{ sku: "SKU-A" }] } }), fail());
  fake.enqueue("GET /stock-movements", json({ _embedded: [{ sku: "SKU-A", quantity: -2, occurredAt: now, operationType: "order_shipped", warehouseDocumentNumber: "DOC-A", productLotNumber: "LOT-A", expirationDate: "2027-01-01" }] }), fail());
  fake.enqueue("GET /products/SKU-A", json({ packs: [{ ean: "0000000000012", quantity: 2 }] }), fail());

  value.certification = { profile: "adapter", dispatch: { addressBeforeSubmission: 6, addressAfterSubmission: 2,
    transport: { "transport-before-submission": { fixture: 3, calls: fake.calls }, "transport-after-submission": { fixture: 4, calls: fake.calls }, "http-failure": { fixture: 5, calls: fake.calls } } },
    observation: { duplicate: [0, 1], outOfOrder: [4, 2], authenticationFailure: 3 }, exceptions: { returned: 2, lostCoarse: 3 },
    paging: { full: { input: { page: 0, size: 2 }, expected: { kind: "page", rows: [pageResult, pageResult] } },
      short: { input: { page: 1, size: 2 }, expected: { kind: "page", rows: [pageResult] } }, empty: { input: { page: 2, size: 2 }, expected: { kind: "page", rows: [] } },
      exhausted: { input: { page: 3, size: 2 }, expected: { kind: "page_exhausted" } }, failure: { input: { page: 4, size: 2 }, expected: { kind: "failed", refusal: { reason: "io_failure", phase: "readback", retryable: true }, error: { code: "http_503", status: 503, retryable: true, mayHaveSucceeded: false } } } },
    stockSync: [ { operation: "getStock", success: { input: [], expected: [{ ...syncIdentity, skuRef: "SKU-A", quantityKind: "snapshot", totalQuantity: 5, forSaleQuantity: 3, reservedOrUnavailableQuantity: 2 }] }, failure: { input: [], throws: { ...syncFailure, retryable: true } } },
      { operation: "getStockMovements", success: { input: [], expected: [{ ...syncIdentity, skuRef: "SKU-A", quantityKind: "movement", quantity: -2, occurredAt: now, operationType: "order_shipped", documentRef: "DOC-A", lotRef: "LOT-A", expirationDate: "2027-01-01" }] }, failure: { input: [], throws: { ...syncFailure, retryable: true } } } ],
    productSync: [ { operation: "ensureProduct", success: { input: ["SKU-A"], expected: { replayed: false } }, failure: { input: ["SKU-A"], throws: syncFailure } },
      { operation: "getProductPacks", success: { input: ["SKU-A"], expected: [{ ean: "0000000000012", quantity: 2 }] }, failure: { input: ["SKU-A"], throws: { ...syncFailure, retryable: true } } },
      { operation: "addProductPack", success: { input: ["SKU-A", { ean: "0000000000012", quantity: 2 }], expected: undefined }, failure: { input: ["SKU-A", { ean: "invalid", quantity: 2 }], throws: { reason: "malformed", phase: "sync", retryable: false } } },
      { operation: "listStockedSkus", success: { input: [], expected: ["SKU-A"] }, failure: { input: [], throws: { ...syncFailure, retryable: true } } } ],
    snapshotOnly: true,
  };
  // Configure the real product write path for success and HTTP failure.
  fake.enqueue("POST /products/SKU-A/packs", json({}));
  fake.enqueue("POST /products", json({}), fail());
  return { value, fake, wire };
}

it("qualifies the real reference adapter offline with invocation-bound fixtures and native refusal probes", async () => {
  const fixture = fullSubject();
  const proof = await runFulfillmentAdapterConformance([fixture.value], { mode: "full" });
  expect(proof.cases.at(-1)?.operation).toBe("full:adapter (offline; no durable host qualification)");
  expect(proof.cases.filter(row => row.operation.startsWith("native refusal:"))).toHaveLength(6);
  fixture.fake.assertDrained();
  expect(fixture.wire.filter(row => row.path === "/orders")).toHaveLength(5);
  expect(fixture.wire.filter(row => row.path === "/fulfilments").slice(-5).map(row => row.query)).toEqual(["?page=0&size=2", "?page=1&size=2", "?page=2&size=2", "?page=3&size=2", "?page=4&size=2"]);
  expect(JSON.stringify(proof)).not.toMatch(/synthetic-credential|synthetic-signature/);
});

it("delivers status tuples explicitly even when fixture storage is oldest first", async () => {
  const fixture = fullSubject(), rows = fixture.value.fixtures.observation!;
  fixture.value.fixtures.observation = [rows[2]!, rows[0]!, rows[1]!, rows[3]!, rows[4]!];
  fixture.value.certification!.observation = { duplicate: [1, 2], outOfOrder: [4, 0], authenticationFailure: 3 };
  const verify = fixture.value.adapter.observation!.verifyAndNormalize, delivered: (string | null)[] = [];
  fixture.value.adapter.observation!.verifyAndNormalize = async (...input) => {
    const result = await verify(...input);
    if (result.kind === "verified") delivered.push(result.observation.fact.occurredAt);
    return result;
  };
  await runFulfillmentAdapterConformance([fixture.value], { mode: "full" });
  expect(delivered.slice(-4)).toEqual([now, now, now, "2026-10-20T10:00:00.000Z"]);
});

it("fails full qualification when an adapter corrupts an older status after a newer one", async () => {
  const fixture = fullSubject(), rows = fixture.value.fixtures.observation!;
  fixture.value.fixtures.observation = [rows[2]!, rows[0]!, rows[1]!, rows[3]!, rows[4]!];
  fixture.value.certification!.observation = { duplicate: [1, 2], outOfOrder: [4, 0], authenticationFailure: 3 };
  const verify = fixture.value.adapter.observation!.verifyAndNormalize;
  let latest = "";
  fixture.value.adapter.observation!.verifyAndNormalize = async (...input) => {
    const result = await verify(...input);
    if (result.kind === "verified") {
      const occurredAt = result.observation.fact.occurredAt!;
      if (occurredAt < latest) return { kind: "refused", refusal: refusal("stale", "normalize") };
      latest = occurredAt;
    }
    return result;
  };
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow("observation fixture");
});

it("rejects transport evidence from an unrelated invocation in a shared log", async () => {
  const fixture = fullSubject(), unrelated = createScriptedFulfillmentFake<{ read: unknown }>();
  unrelated.enqueue("read", { kind: "transport-before-submission" });
  await expect(unrelated.invoke("read")).rejects.toThrow("transport-before-submission");
  fixture.value.certification!.dispatch!.transport["transport-before-submission"].calls = unrelated.calls;
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow("transport-before-submission injected fault required for dispatch invocation");
});

it("rejects a before-submission result after provider access", async () => {
  const fixture = fullSubject(), dispatch = fixture.value.adapter.dispatch.dispatch, count = fixture.value.readIoCount;
  let calls = 0;
  fixture.value.readIoCount = () => count() + calls;
  fixture.value.adapter.dispatch.dispatch = async (input, evidence) => {
    const result = await dispatch(input, evidence);
    if (input.requestKey === "before-send" && !evidence.commandFingerprint.endsWith(":mismatch") && calls === 0) calls++;
    return result;
  };
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow("transport-before-submission submission I/O");
});

it("rejects the missing-items fixture as an address witness", async () => {
  const fixture = fullSubject();
  fixture.value.certification!.dispatch!.addressBeforeSubmission = 1;
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow("address invalid with valid items");
});

it.each(["address", "authentication", "exception"] as const)("rejects an unexecuted %s expectation outside the baseline array entries", async scenario => {
  const fixture = fullSubject(), { fixtures } = fixture.value, kit = fixture.value.certification!;
  if (scenario === "address") {
    const rows = [...fixtures.dispatch];
    rows[-1] = { ...rows[6]!, input: { ...request(), requestKey: "never-prepared", recipient: { ...request().recipient, line1: "" } } };
    fixtures.dispatch = rows;
    kit.dispatch!.addressBeforeSubmission = -1;
  } else if (scenario === "authentication") {
    const rows = [...fixtures.observation!];
    rows[-1] = { ...rows[3]!, input: rows[0]!.input };
    rows[3] = rows[0]!;
    fixtures.observation = rows;
    kit.observation!.authenticationFailure = -1;
  } else {
    const rows = [...fixtures.readback!];
    rows[-1] = { ...rows[2]!, input: [readInput("external-missing")] };
    fixtures.readback = rows;
    kit.exceptions!.returned = -1;
  }
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow(
    "validation:uncloneable_data");
});

it.each([
  ["address-rejected", "address after submission I/O"],
  ["after-send", "transport-after-submission submission I/O"],
  ["server-failure", "http-failure submission I/O"],
])("rejects %s submission evidence without a provider call", async (key, hint) => {
  const fixture = fullSubject(), dispatch = fixture.value.adapter.dispatch.dispatch, count = fixture.value.readIoCount;
  let hidden = 0;
  fixture.value.readIoCount = () => count() - hidden;
  fixture.value.adapter.dispatch.dispatch = async (input, evidence) => {
    const before = count(), result = await dispatch(input, evidence);
    if (input.requestKey === key) hidden += count() - before;
    return result;
  };
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow(hint);
});

it("rejects selection refusal after provider access", async () => {
  const fixture = fullSubject(), prepare = fixture.value.adapter.dispatch.prepare, count = fixture.value.readIoCount;
  let calls = 0;
  fixture.value.readIoCount = () => count() + calls;
  fixture.value.adapter.dispatch.prepare = async input => { if (!input.selection.providerRef) calls++; return prepare(input); };
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow("selection refusal before I/O");
});

it.each(["observation", "readback", "sync"] as const)("rejects unsupported %s after provider access", async operation => {
  const fixture = fullSubject(), count = fixture.value.readIoCount;
  const unsupported = refusal("unsupported", operation === "observation" ? "verify" : operation === "readback" ? "readback" : "sync");
  let calls = 0;
  fixture.value.readIoCount = () => count() + calls;
  if (operation === "observation") {
    fixture.value.adapter.capabilities.operations = { ...fixture.value.adapter.capabilities.operations, verifyObservation: { supported: false, reason: "not_implemented" } };
    delete fixture.value.certification!.observation;
    fixture.value.fixtures.observation = [{ input: [webhook(webhookPayload)], expected: { kind: "refused", refusal: unsupported } }];
    fixture.value.adapter.observation!.verifyAndNormalize = async () => { calls++; return { kind: "refused", refusal: unsupported }; };
  } else if (operation === "readback") {
    fixture.value.adapter.capabilities.operations = { ...fixture.value.adapter.capabilities.operations, readback: { supported: false, reason: "not_implemented" } };
    delete fixture.value.certification!.exceptions; delete fixture.value.certification!.paging;
    fixture.value.fixtures.readback = [{ input: [readInput("external-a")], expected: { kind: "unsupported", refusal: unsupported } }];
    fixture.value.adapter.readback!.read = async () => { calls++; return { kind: "unsupported", refusal: unsupported }; };
  } else {
    fixture.value.adapter.capabilities.operations = { ...fixture.value.adapter.capabilities.operations, syncStock: { supported: false, reason: "not_implemented" } };
    fixture.value.fixtures.stockSync = [{ operation: "getStock", input: [], expected: { kind: "refused", refusal: { reason: "unsupported", phase: "sync", retryable: false } } }];
    fixture.value.adapter.stockSync!.getStock = async () => { calls++; throw unsupported; };
  }
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow(`unsupported ${operation} before I/O`);
});

it("requires distinct label-void success and refusal witnesses", async () => {
  const fixture = fullSubject(), contradictory = { providerDeletion: "confirmed" as const, labelDeleted: true, canProceed: true, refusal: refusal("io_failure", "dispatch") };
  fixture.value.adapter.capabilities.operations = { ...fixture.value.adapter.capabilities.operations, labelVoid: { supported: true } };
  fixture.value.adapter.label!.void = async () => contradictory;
  fixture.value.fixtures.label!.void = [{ input: [{ parcelRef: "parcel-a", document: null }], expected: contradictory }];
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow("validation:fixtures");
});

it("rejects status tuples that describe different inputs or shipments", async () => {
  const duplicate = fullSubject();
  const rows = [...duplicate.value.fixtures.observation!];
  rows[1] = { ...rows[1]!, input: [{ ...rows[1]!.input[0], receivedAt: "2026-10-22T10:00:00.000Z" }] };
  // Keep the result stable to isolate the fixture-identity check from normalization.
  const verify = duplicate.value.adapter.observation!.verifyAndNormalize;
  duplicate.value.adapter.observation!.verifyAndNormalize = input => verify({ ...input, receivedAt: now });
  duplicate.value.fixtures.observation = rows;
  await expect(runFulfillmentAdapterConformance([duplicate.value], { mode: "full" })).rejects.toThrow("full duplicate input");
  const shipment = fullSubject(), older = shipment.value.fixtures.observation![2]!;
  if (older.expected.kind !== "verified") throw Error("Expected older observation");
  older.expected.observation.correlation.externalRef = "unrelated-shipment";
  const normalize = shipment.value.adapter.observation!.verifyAndNormalize;
  shipment.value.adapter.observation!.verifyAndNormalize = async input => {
    const result = await normalize(input);
    if (result.kind === "verified" && result.observation.fact.occurredAt !== now) result.observation.correlation.externalRef = "unrelated-shipment";
    return result;
  };
  await expect(runFulfillmentAdapterConformance([shipment.value], { mode: "full" })).rejects.toThrow("full out-of-order same shipment");
});

it.each([
  ["dispatch", (s: FulfillmentAdapterTestSubject) => { delete s.certification!.dispatch; }, "dispatch scenarios required"],
  ["label", (s: FulfillmentAdapterTestSubject) => { s.fixtures.label!.read = []; }, "full unsupported labelRead refusal probe required"],
  ["observation", (s: FulfillmentAdapterTestSubject) => { delete s.certification!.observation; }, "observation scenarios required"],
  ["chronology", (s: FulfillmentAdapterTestSubject) => { s.certification!.observation!.outOfOrder = [2, 4]; }, "out-of-order chronology"],
  ["exception", (s: FulfillmentAdapterTestSubject) => { delete s.certification!.exceptions; }, "exception fixtures required"],
  ["paging", (s: FulfillmentAdapterTestSubject) => { delete s.certification!.paging; }, "numbered paging fixtures required"],
  ["sync", (s: FulfillmentAdapterTestSubject) => { s.certification!.stockSync = []; }, "stockSync witnesses required"],
  ["movements", (s: FulfillmentAdapterTestSubject) => { delete s.certification!.snapshotOnly; }, "snapshot-only refusal probe required"],
] as const)("fails full qualification on missing or invalid %s evidence", async (_name, mutate, hint) => {
  const fixture = fullSubject(); mutate(fixture.value);
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow(hint);
});

it("rejects a refusal that calls the provider and a snapshot-only probe that calls movements", async () => {
  const label = fullSubject(); let calls = 0;
  const read = label.value.adapter.label!.read;
  label.value.adapter.label!.read = async input => { calls++; return read(input); };
  const count = label.value.readIoCount; label.value.readIoCount = () => count() + calls;
  await expect(runFulfillmentAdapterConformance([label.value], { mode: "full" })).rejects.toThrow("unsupported label before I/O");
  const movement = fullSubject();
  Object.assign(movement.value.certification!, { snapshotOnly: { invoke: async () => refusal("stock_movements_unsupported", "sync"), readMovementCalls: () => 0 } });
  await expect(runFulfillmentAdapterConformance([movement.value], { mode: "full" })).rejects.toThrow("validation:uncloneable_data");
});


it("refuses false label-deletion confirmation and authentication refusal after provider access", async () => {
  const label = fullSubject();
  label.value.adapter.label!.void = async () => ({ providerDeletion: "confirmed", labelDeleted: true, canProceed: true, refusal: refusal("unsupported", "dispatch") });
  label.value.fixtures.label!.void![0]!.expected = { providerDeletion: "confirmed", labelDeleted: true, canProceed: true, refusal: refusal("unsupported", "dispatch") };
  await expect(runFulfillmentAdapterConformance([label.value], { mode: "full" })).rejects.toThrow("validation:fixtures");
  const auth = fullSubject(); let calls = 0;
  const verify = auth.value.adapter.observation!.verifyAndNormalize, count = auth.value.readIoCount;
  auth.value.readIoCount = () => count() + calls;
  auth.value.adapter.observation!.verifyAndNormalize = async input => { const result = await verify(input); if (result.kind === "refused") calls++; return result; };
  await expect(runFulfillmentAdapterConformance([auth.value], { mode: "full" })).rejects.toThrow("authentication refusal before I/O");
});

it.each([
  ["productSync", "ensureProduct", null, "skipped"],
  ["productSync", "ensureProduct", { replayed: true }, "replayed"],
  ["stockSync", "getStock", [], "empty"],
  ["stockSync", "getStock", [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref" }], "rejected-only"],
  ["stockSync", "getStock", [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref", skuRef: "SKU-A", quantityKind: "snapshot" }], "rejected-with-stock-fields"],
  ["stockSync", "getStockMovements", [], "empty"],
  ["stockSync", "getStockMovements", [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref" }], "rejected-only"],
  ["stockSync", "getStockMovements", [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref", skuRef: "SKU-A", quantityKind: "movement" }], "rejected-with-movement-fields"],
  ["productSync", "getProductPacks", [], "empty"],
  ["productSync", "getProductPacks", [{ ean: " ", quantity: 1 }], "unaddressable"],
  ["productSync", "listStockedSkus", [], "empty"],
  ["productSync", "listStockedSkus", [" "], "unaddressable"],
] as const)("rejects %s.%s with %j as the only positive witness (%s)", async (name, operation, expected, shape) => {
  const fixture = fullSubject(), subject = fixture.value;
  const row = subject.certification![name]!.find(row => row.operation === operation)!;
  Object.assign(row.success, { expected });
  const port = subject.adapter[name] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const invoke = port[operation]!, baselineCalls = subject.fixtures[name]!.filter(row => row.operation === operation).length;
  let calls = 0;
  port[operation] = async (...args) => {
    const result = await invoke(...args);
    return ++calls === baselineCalls + 1 ? expected : result;
  };
  await expect(runFulfillmentAdapterConformance([subject], { mode: "full" })).rejects.toThrow(shape.startsWith("rejected-with") ? "validation:fixtures" : `full ${operation} positive success required`);
});

it("allows a skipped ensureProduct fixture alongside a positive full witness", async () => {
  const fixture = fullSubject(), subject = fixture.value, ensure = subject.adapter.productSync!.ensureProduct;
  subject.adapter.productSync!.ensureProduct = sku => sku === "skip" ? Promise.resolve(null) : ensure(sku);
  subject.fixtures.productSync = [...subject.fixtures.productSync!, { operation: "ensureProduct", input: ["skip"], expected: null }];
  await expect(runFulfillmentAdapterConformance([subject], { mode: "full" })).resolves.toHaveProperty("subjects");
  fixture.fake.assertDrained();
});

it.each([
  ["stockSync", "getStock"], ["stockSync", "getStockMovements"],
  ["productSync", "ensureProduct"], ["productSync", "getProductPacks"],
  ["productSync", "addProductPack"], ["productSync", "listStockedSkus"],
] as const)("binds %s.%s credit to its fixture role and observed invocation", async (name, operation) => {
  for (const bypass of ["mixed success", "mixed failure", "return-only failure", "always throws", "always returns"] as const) {
    const fixture = fullSubject(), subject = fixture.value;
    const row = subject.certification![name]!.find(row => row.operation === operation)!;
    const positive = row.success.expected, negative = row.failure.throws;
    // Simulate untyped JavaScript, including mixed keys whose value is undefined.
    if (bypass === "mixed success") Object.assign(row.success, { throws: negative });
    if (bypass === "mixed failure" || bypass === "return-only failure") Object.assign(row.failure, { expected: positive });
    if (bypass === "return-only failure") Reflect.deleteProperty(row.failure, "throws");
    const port = subject.adapter[name] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const invoke = port[operation]!, baselineCalls = subject.fixtures[name]!.filter(row => row.operation === operation).length;
    let calls = 0;
    port[operation] = async (...args) => {
      if (++calls <= baselineCalls) return invoke(...args);
      if (bypass === "mixed success" || bypass === "always throws") throw negative;
      return positive;
    };
    const hint = bypass === "always throws" ? "success did not return" : bypass === "always returns" ? "failure did not throw"
      : bypass === "mixed success" ? "success fixture role" : "failure fixture role";
    await expect(runFulfillmentAdapterConformance([subject], { mode: "full" }), bypass).rejects.toThrow(bypass.startsWith("always") ? `full ${operation} ${hint}` : "validation:fixtures");
    expect(calls, bypass).toBe(bypass === "always throws" ? baselineCalls + 1 : bypass === "always returns" ? baselineCalls + 2 : 0);
  }
});

it.each(["create", "read"] as const)("rejects label %s success carrying refusal data for either capability declaration", async operation => {
  for (const supported of [false, true]) {
    for (const source of ["actual", "expected", "both"] as const) {
      const { value } = fullSubject(), unsupported = refusal("unsupported", "dispatch");
      const success = operation === "create" ? { kind: "created" as const, parcelRef: "parcel-a", document: null }
        : { kind: "available" as const, url: "https://labels.example.test/a", expiresAt: null };
      const contradictory = { ...success, refusal: unsupported };
      Object.assign(value.adapter.capabilities.operations, { [operation === "create" ? "labelCreate" : "labelRead"]: { ...(supported ? { supported: true } : { supported: false, reason: "not_exposed" }) } });
      const rows = value.fixtures.label![operation]!;
      Object.assign(rows[0]!, { expected: source === "actual" ? success : contradictory });
      Object.assign(value.adapter.label!, { [operation]: async () => source === "expected" ? success : contradictory });
      await expect(runFulfillmentAdapterConformance([value], { mode: "full" }), `${supported}/${source}`).rejects.toThrow(source === "actual" ? `label ${operation} contradictory result` : "validation:fixtures");
    }
  }
});

it.each(["prepare", "dispatch", "create", "read", "observation", "readback", "page"] as const)("rejects both directions of contradictory %s union results", async operation => {
  for (const direction of ["success with refusal", "refusal with success"] as const) {
    const { value } = fullSubject(), { fixtures, adapter } = value;
    const contradict = (result: unknown) => {
      const success = result as Record<string, unknown>;
      return direction === "success with refusal" ? { ...success, refusal: refusal("io_failure", "dispatch") }
        : { ...success, kind: operation === "dispatch" ? "not_dispatched" : operation === "readback" ? "unknown" : operation === "page" ? "failed" : "refused", refusal: refusal("io_failure", "dispatch") };
    };
    if (operation === "prepare") {
      const invoke = adapter.dispatch.prepare;
      Object.assign(fixtures.dispatch[0]!, { expectedPrepare: contradict(fixtures.dispatch[0]!.expectedPrepare) });
      adapter.dispatch.prepare = async input => input.selection.providerRef ? contradict(await invoke(input)) as never : invoke(input);
    } else if (operation === "dispatch") {
      const invoke = adapter.dispatch.dispatch;
      Object.assign(fixtures.dispatch[0]!, { expectedDispatch: contradict(fixtures.dispatch[0]!.expectedDispatch) });
      adapter.dispatch.dispatch = async (input, evidence) => {
        const result = await invoke(input, evidence);
        return result.kind === "accepted" ? contradict(result) as never : result;
      };
    } else if (operation === "create" || operation === "read") {
      const success = operation === "create" ? { kind: "created", parcelRef: "parcel-a", document: null }
        : { kind: "available", url: "https://labels.example.test/a", expiresAt: null };
      const result = contradict(success);
      Object.assign(fixtures.label![operation]![0]!, { expected: result });
      Object.assign(adapter.label!, { [operation]: async () => result });
    } else if (operation === "observation") {
      const invoke = adapter.observation!.verifyAndNormalize;
      Object.assign(fixtures.observation![0]!, { expected: contradict(fixtures.observation![0]!.expected) });
      adapter.observation!.verifyAndNormalize = async input => contradict(await invoke(input)) as never;
    } else if (operation === "readback") {
      const invoke = adapter.readback!.read;
      Object.assign(fixtures.readback![0]!, { expected: contradict(fixtures.readback![0]!.expected) });
      adapter.readback!.read = async input => contradict(await invoke(input)) as never;
    } else {
      const invoke = adapter.reconciliation!.readPage;
      Object.assign(value.certification!.paging!.full, { expected: contradict(value.certification!.paging!.full.expected) });
      adapter.reconciliation!.readPage = async input => contradict(await invoke(input)) as never;
    }
    await expect(runFulfillmentAdapterConformance([value], { mode: "full" }), direction).rejects.toThrow("validation:fixtures");
  }
});

it.each(["stockSync", "productSync"] as const)("rejects %s positive payloads carrying failure discriminants", async name => {
  const { value } = fullSubject(), operation = name === "stockSync" ? "getStock" : "ensureProduct";
  const row = value.certification![name]!.find(row => row.operation === operation)!;
  const contradictory = name === "stockSync" ? [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref", skuRef: "SKU-A", quantityKind: "snapshot" }]
    : { replayed: false, refusal: refusal("io_failure", "sync") };
  Object.assign(row.success, { expected: contradictory });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("validation:fixtures");
});

it("rejects a paging failure slot whose expected discriminant reports success", async () => {
  const { value } = fullSubject(), pages = value.certification!.paging!;
  Object.assign(pages.failure, { expected: { kind: "page", rows: [] } });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("fixture discriminant contradicts role");
});

it.each(["create", "read", "void"] as const)("qualifies supported label %s only with distinct success and refusal results", async operation => {
  const { value } = fullSubject();
  Object.assign(value.adapter.capabilities.operations, { [operation === "create" ? "labelCreate" : operation === "read" ? "labelRead" : "labelVoid"]: { supported: true } });
  const failed = operation === "void" ? { providerDeletion: "unconfirmed", labelDeleted: true, canProceed: false, refusal: refusal("io_failure", "dispatch") }
    : { kind: "refused", refusal: refusal("io_failure", "dispatch") };
  const success = operation === "create" ? { kind: "created", parcelRef: "parcel-a", document: null }
    : operation === "read" ? { kind: "available", url: "https://labels.example.test/a", expiresAt: null }
      : { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: true };
  const rows = value.fixtures.label![operation]!;
  const input = operation === "create" ? { ...request(), requestKey: "label-success" }
    : operation === "read" ? { objectRef: "label-success", mediaType: "application/pdf", externalRef: null }
      : { parcelRef: "label-success", document: null };
  Object.assign(rows[0]!, { expected: failed });
  Object.assign(value.fixtures.label!, { [operation]: [...rows, { input: [input], expected: success }] });
  Object.assign(value.adapter.label!, { [operation]: async (received: unknown) => JSON.stringify(received) === JSON.stringify(input) ? success : failed });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).resolves.toHaveProperty("subjects");
});

it.each([["stockSync", "getStock"], ["productSync", "ensureProduct"]] as const)("rejects a thrown %s.%s refusal carrying success payload", async (name, operation) => {
  const { value } = fullSubject(), row = value.certification![name]!.find(row => row.operation === operation)!;
  const port = value.adapter[name] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const invoke = port[operation]!, baselineCalls = value.fixtures[name]!.filter(row => row.operation === operation).length;
  let calls = 0;
  port[operation] = async (...args) => {
    if (++calls <= baselineCalls + 1) return invoke(...args);
    throw { ...row.failure.throws, ...(name === "stockSync" ? { skuRef: "SKU-A", quantityKind: "snapshot" } : { replayed: false }) };
  };
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow(`full ${operation} contradictory result`);
});

it("audit 1 and FK-r5B-1 refuse missing paging expectations before any adapter invocation", async () => {
  const { value } = fullSubject(), prepare = vi.spyOn(value.adapter.dispatch, "prepare");
  Reflect.deleteProperty(value.certification!.paging!.full, "expected");
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("validation:fixtures");
  expect(prepare).not.toHaveBeenCalled();
});
it.each(["expectedPrepare", "expectedDispatch"] as const)("audit 1 requires %s independently on every reachable dispatch slot", async key => {
  const { value } = fullSubject(); Reflect.deleteProperty(value.fixtures.dispatch[0]!, key);
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("validation:fixtures");
});
it("audit 2 never credits a label success appended after the label invocations", async () => {
  const { value } = fullSubject(), read = value.adapter.readback!.read;
  Object.assign(value.adapter.capabilities.operations, { labelCreate: { supported: true } });
  const failed = { kind: "refused" as const, refusal: refusal("io_failure", "dispatch") };
  value.fixtures.label!.create = [{ input: [request()], expected: failed }]; value.adapter.label!.create = async () => failed;
  value.adapter.readback!.read = async input => { value.fixtures.label!.create = [...value.fixtures.label!.create!, { input: [request()], expected: { kind: "created", parcelRef: "unexecuted", document: null } }]; return read(input); };
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("full labelCreate success and failure required");
});
it("audit 3 rejects a proxy outcome before classification and comparison", async () => {
  const { value } = fullSubject(), dispatch = value.adapter.dispatch.dispatch;
  value.adapter.dispatch.dispatch = async (...args) => new Proxy(await dispatch(...args), { has: () => false });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("validation:uncloneable_data");
});
it("audit 4 snapshots inputs and rejects live expectation getters", async () => {
  const mutation = fullSubject(), prepare = mutation.value.adapter.dispatch.prepare;
  mutation.value.certification!.dispatch!.addressBeforeSubmission = 1;
  mutation.value.adapter.dispatch.prepare = async input => { const result = await prepare(input); input.recipient.city = ""; Object.assign(input, { lines: request().lines }); return result; };
  await expect(runFulfillmentAdapterConformance([mutation.value], { mode: "full" })).rejects.toThrow("full address invalid with valid items");
  const getter = fullSubject(); Object.defineProperty(getter.value.fixtures.label!.create![0], "expected", { enumerable: true, get: () => ({ kind: "created", parcelRef: "late", document: null }) });
  await expect(runFulfillmentAdapterConformance([getter.value], { mode: "full" })).rejects.toThrow("validation:uncloneable_data");
});
it("audit 5 cannot credit an input getter that throws instead of invoking sync", async () => {
  const { value } = fullSubject(), invoke = vi.spyOn(value.adapter.stockSync!, "getStock");
  Object.defineProperty(value.certification!.stockSync![0]!.failure, "input", { enumerable: true, get() { throw refusal("io_failure", "sync"); } });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("validation:uncloneable_data"); expect(invoke).not.toHaveBeenCalled();
});
it.each(["cancel", "courierPickup"] as const)("audit 7 refuses supported %s without a certifiable success port", async capability => {
  const { value } = fullSubject(); Object.assign(value.adapter.capabilities.operations, { [capability]: { supported: true } });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow(`capability_not_certifiable:${capability}`);
});
it("audit 7 requires pickup witnesses and refuses exact absence without readback", async () => {
  const pickup = fullSubject(); pickup.value.fixtures.dispatch = pickup.value.fixtures.dispatch.slice(0, 7);
  await expect(runFulfillmentAdapterConformance([pickup.value], { mode: "full" })).rejects.toThrow("full pickupPoint success and failure required");
  const absence = fullSubject(); Object.assign(absence.value.adapter.capabilities.operations, { exactAbsence: { supported: true }, readback: { supported: false, reason: "not_exposed" } });
  await expect(runFulfillmentAdapterConformance([absence.value], { mode: "full" })).rejects.toThrow("capability_not_certifiable:exactAbsence without readback");
});
it.each([["verifyObservation", "observation"], ["readback", "readback"], ["syncStock", "stockSync"], ["syncProducts", "productSync"]] as const)("audit 8 requires an executed unsupported %s refusal", async (capability, fixtures) => {
  const { value } = fullSubject(); Object.assign(value.adapter.capabilities.operations, { [capability]: { supported: false, reason: "not_exposed" } });
  Reflect.deleteProperty(value.fixtures, fixtures);
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow(`full unsupported ${capability} refusal probe required`);
});
it("audit 10 rejects a snapshot-only callback in place of the runner's real worker probe", async () => {
  const { value } = fullSubject(); Object.assign(value.certification!, { snapshotOnly: { invoke: async () => refusal("stock_movements_unsupported", "sync"), readMovementCalls: () => 0 } });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("validation:uncloneable_data");
});
it.each(["dispatch", "observation", "exceptions"] as const)("audit 11 prevents one slot serving two %s scenarios", async name => {
  const { value } = fullSubject(), kit = value.certification!;
  if (name === "dispatch") kit.dispatch!.transport["http-failure"].fixture = kit.dispatch!.transport["transport-after-submission"].fixture;
  if (name === "observation") kit.observation!.outOfOrder = [kit.observation!.duplicate[0], kit.observation!.outOfOrder[1]];
  if (name === "exceptions") kit.exceptions!.lostCoarse = kit.exceptions!.returned;
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow(`validation:scenario_indices:${name}`);
});
it("audit 11 requires exactly one submission rather than any positive I/O delta", async () => {
  const { value } = fullSubject(), dispatch = value.adapter.dispatch.dispatch, count = value.readIoCount; let extra = 0;
  value.readIoCount = () => count() + extra;
  value.adapter.dispatch.dispatch = async (...args) => { const result = await dispatch(...args); if (args[0].requestKey === "after-send" && !args[1].commandFingerprint.endsWith(":mismatch") && extra === 0) extra++; return result; };
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("transport-after-submission submission I/O");
});
it.each(["create", "read", "void", "reason", "phase", "nan", "missing-void-expectation"] as const)("audit 12 refuses malformed %s contract data", async shape => {
  const { value } = fullSubject();
  if (shape === "create" || shape === "read" || shape === "void") Object.assign(value.fixtures.label![shape]![0]!, { expected: shape === "void" ? { canProceed: true } : { kind: shape === "create" ? "created" : "available" } });
  if (shape === "reason" || shape === "phase") Object.assign(value.certification!.stockSync![0]!.failure.throws, { [shape]: "unrecognized" });
  if (shape === "nan") Object.assign(value.fixtures.dispatch[2]!.expectedDispatch!, { error: { code: "invalid", status: NaN, retryable: false, mayHaveSucceeded: false } });
  if (shape === "missing-void-expectation") Reflect.deleteProperty(value.certification!.productSync!.find(row => row.operation === "addProductPack")!.success, "expected");
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("validation:fixtures");
});
it("audit 12 refuses unmapped or unknown-only pages as positive success", async () => {
  const { value } = fullSubject(), pages = value.certification!.paging!, read = value.adapter.reconciliation!.readPage;
  const unknown = { kind: "unknown" as const, refusal: refusal("local_missing", "readback") }, expected = { kind: "page" as const, rows: [unknown, unknown] };
  pages.full.expected = expected; value.adapter.reconciliation!.readPage = input => input.page === 0 ? Promise.resolve(expected) : read(input);
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("full paging full positive success required");
});
it("audit 12 refuses unsupported as the failure witness of supported label creation", async () => {
  const { value } = fullSubject(); Object.assign(value.adapter.capabilities.operations, { labelCreate: { supported: true } });
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("label create supported_failure_unsupported");
});
it("audit 13 rejects a caller-forged fault log rather than trusting its entries", async () => {
  const { value } = fullSubject(); const forged = [{ call: "submit", kind: "transport-after-submission" as const }]; value.certification!.dispatch!.transport["transport-after-submission"].calls = forged;
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("invalid_fault_log");
});
it("pins the closed no-port list and the reference bundle's missing courier pickup port", () => {
  expect(PORTLESS_CAPABILITIES).toEqual(["courierPickup"]);
  expectTypeOf<Extract<keyof ReturnType<typeof createOmnipackFulfillmentAdapter> | keyof FulfillmentAdapterTestSubject["adapter"] | NonNullable<Parameters<typeof capabilityReader.readFulfillmentCapabilities>[2]>["operation"], typeof PORTLESS_CAPABILITIES[number]>>().toEqualTypeOf<never>();
});
it("rejects contradictory native refusal output without crediting platform code as adapter success", async () => {
  const { value } = fullSubject(); const read = vi.spyOn(capabilityReader, "readFulfillmentCapabilities").mockReturnValueOnce({ kind: "refused", refusal: refusal("provider_cancel_unsupported", "selection"), descriptor: value.adapter.capabilities } as never);
  try { await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("native provider_cancel_unsupported contradictory result"); } finally { read.mockRestore(); }
});

it("audit 12 never normalizes a legacy page fact into an equal current expectation", async () => {
  const { value } = fullSubject(), read = value.adapter.reconciliation!.readPage;
  value.adapter.reconciliation!.readPage = async input => {
    const result = await read(input);
    if (result.kind === "page") for (const row of result.rows) if (row.kind === "found") {
      const { rawEvent, ...shared } = row.observation.fact;
      row.observation.fact = { ...shared, schemaVersion: 0, rawEventReference: rawEvent.reference, rawEventSha256: rawEvent.digest } as never;
    }
    return result;
  };
  await expect(runFulfillmentAdapterConformance([value], { mode: "full" })).rejects.toThrow("full paging full contradictory result");
});
