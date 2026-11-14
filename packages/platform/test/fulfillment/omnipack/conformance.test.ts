import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runFulfillmentAdapterConformance, runFulfillmentDispatchWorker } from "../../../src/fulfillment/index.js";
import { createScriptedFulfillmentFake } from "../../../src/fulfillment/testing/index.js";
import type { FulfillmentAdapterTestSubject } from "../../../src/fulfillment/testing/index.js";
import { runFulfillmentStockSyncWorker } from "../../../src/fulfillment/index.js";
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
    { input: [{ ...webhook(webhookPayload), headers: { authorization: "Bearer incorrect-placeholder" } }], expected: { kind: "refused", refusal: refusal("untrusted", "verify") } }];
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
  let movements = 0;
  value.certification = { profile: "adapter", dispatch: { addressBeforeSubmission: 6, addressAfterSubmission: 2,
    transport: { "transport-before-submission": { fixture: 3, calls: fake.calls }, "transport-after-submission": { fixture: 4, calls: fake.calls }, "http-failure": { fixture: 5, calls: fake.calls } } },
    observation: { duplicate: [0, 1], outOfOrder: [0, 2], authenticationFailure: 3 }, exceptions: { returned: 2, lostCoarse: 3 },
    paging: { full: { input: { page: 0, size: 2 }, expected: { kind: "page", rows: [pageResult, pageResult] } },
      short: { input: { page: 1, size: 2 }, expected: { kind: "page", rows: [pageResult] } }, empty: { input: { page: 2, size: 2 }, expected: { kind: "page", rows: [] } },
      exhausted: { input: { page: 3, size: 2 }, expected: { kind: "page_exhausted" } }, failure: { input: { page: 4, size: 2 }, expected: { kind: "failed", refusal: { reason: "io_failure", phase: "readback", retryable: true }, error: { code: "http_503", status: 503, retryable: true, mayHaveSucceeded: false } } } },
    stockSync: [ { operation: "getStock", success: { input: [], expected: [{ ...syncIdentity, skuRef: "SKU-A", quantityKind: "snapshot", totalQuantity: 5, forSaleQuantity: 3, reservedOrUnavailableQuantity: 2 }] }, failure: { input: [], throws: { ...syncFailure, retryable: true } } },
      { operation: "getStockMovements", success: { input: [], expected: [{ ...syncIdentity, skuRef: "SKU-A", quantityKind: "movement", quantity: -2, occurredAt: now, operationType: "order_shipped", documentRef: "DOC-A", lotRef: "LOT-A", expirationDate: "2027-01-01" }] }, failure: { input: [], throws: { ...syncFailure, retryable: true } } } ],
    productSync: [ { operation: "ensureProduct", success: { input: ["SKU-A"], expected: { replayed: false } }, failure: { input: ["SKU-A"], throws: syncFailure } },
      { operation: "getProductPacks", success: { input: ["SKU-A"], expected: [{ ean: "0000000000012", quantity: 2 }] }, failure: { input: ["SKU-A"], throws: { ...syncFailure, retryable: true } } },
      { operation: "addProductPack", success: { input: ["SKU-A", { ean: "0000000000012", quantity: 2 }], expected: undefined }, failure: { input: ["SKU-A", { ean: "invalid", quantity: 2 }], throws: { reason: "malformed", phase: "sync", retryable: false } } },
      { operation: "listStockedSkus", success: { input: [], expected: ["SKU-A"] }, failure: { input: [], throws: { ...syncFailure, retryable: true } } } ],
    snapshotOnly: { readMovementCalls: () => movements, async invoke() {
      const result = await runFulfillmentStockSyncWorker({ stockMovements: false, movementBatchSize: 1, now: () => new Date(now),
        compatibility: { syncRunId: () => "sync-offline", timeZone: "UTC", staleEvidenceSku: "sentinel", currentKey: () => "current", snapshotKey: () => "snapshot", lowStockKey: () => "low", staleKey: () => "stale" },
        provider: { getStock: async () => [], getStockMovements: async () => { movements += 1; return []; } }, port: {
          readCursor: async () => null, recordCursor: async () => {}, readLocalInventoryStock: async () => [], readSkuInventoryClasses: async () => new Map(), readActiveReservations: async () => new Map(),
          recordStockSnapshot: async () => ({ replayed: false, readBack: true }), recordProviderStockCurrent: async () => ({ replayed: false, readBack: true }),
          recordMovement: async () => ({ replayed: false, readBack: true }), recordLowStockEvidence: async () => ({ replayed: false }), resolveLowStockEvidence: async () => ({ resolved: 0 }),
        } }); return result.movementRefusal;
    } },
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
  expect(proof.cases.filter(row => row.operation.startsWith("native refusal:"))).toHaveLength(8);
  fixture.fake.assertDrained();
  expect(fixture.wire.filter(row => row.path === "/orders")).toHaveLength(4);
  expect(fixture.wire.filter(row => row.path === "/fulfilments").slice(-5).map(row => row.query)).toEqual(["?page=0&size=2", "?page=1&size=2", "?page=2&size=2", "?page=3&size=2", "?page=4&size=2"]);
  expect(JSON.stringify(proof)).not.toMatch(/synthetic-credential|synthetic-signature/);
});

it("delivers status tuples explicitly even when fixture storage is oldest first", async () => {
  const fixture = fullSubject(), rows = fixture.value.fixtures.observation!;
  fixture.value.fixtures.observation = [rows[2]!, rows[0]!, rows[1]!, rows[3]!];
  fixture.value.certification!.observation = { duplicate: [1, 2], outOfOrder: [1, 0], authenticationFailure: 3 };
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
  fixture.value.fixtures.observation = [rows[2]!, rows[0]!, rows[1]!, rows[3]!];
  fixture.value.certification!.observation = { duplicate: [1, 2], outOfOrder: [1, 0], authenticationFailure: 3 };
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
    scenario === "address" ? "full address before submission" : scenario === "authentication" ? "full authentication refusal" : "full returned coarse exception");
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
    fixture.value.fixtures.observation = [{ input: [webhook(webhookPayload)], expected: { kind: "refused", refusal: unsupported } }];
    fixture.value.adapter.observation!.verifyAndNormalize = async () => { calls++; return { kind: "refused", refusal: unsupported }; };
  } else if (operation === "readback") {
    fixture.value.adapter.capabilities.operations = { ...fixture.value.adapter.capabilities.operations, readback: { supported: false, reason: "not_implemented" } };
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
  await expect(runFulfillmentAdapterConformance([fixture.value], { mode: "full" })).rejects.toThrow("label void success and failure required");
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
  ["label", (s: FulfillmentAdapterTestSubject) => { s.fixtures.label!.read = []; }, "label read refusal fixture required"],
  ["observation", (s: FulfillmentAdapterTestSubject) => { delete s.certification!.observation; }, "observation scenarios required"],
  ["chronology", (s: FulfillmentAdapterTestSubject) => { s.certification!.observation!.outOfOrder = [2, 0]; }, "out-of-order chronology"],
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
  const movement = fullSubject(); let movementCalls = 0;
  movement.value.certification!.snapshotOnly = { readMovementCalls: () => movementCalls, async invoke() { movementCalls++; return { reason: "stock_movements_unsupported", phase: "sync", retryable: false }; } };
  await expect(runFulfillmentAdapterConformance([movement.value], { mode: "full" })).rejects.toThrow("snapshot-only no movement I/O");
});


it("refuses false label-deletion confirmation and authentication refusal after provider access", async () => {
  const label = fullSubject();
  label.value.adapter.label!.void = async () => ({ providerDeletion: "confirmed", labelDeleted: true, canProceed: true, refusal: refusal("unsupported", "dispatch") });
  label.value.fixtures.label!.void![0]!.expected = { providerDeletion: "confirmed", labelDeleted: true, canProceed: true, refusal: refusal("unsupported", "dispatch") };
  await expect(runFulfillmentAdapterConformance([label.value], { mode: "full" })).rejects.toThrow("unsupported label void cannot confirm deletion");
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
] as const)("rejects %s.%s with %j as the only positive witness (%s)", async (name, operation, expected) => {
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
  await expect(runFulfillmentAdapterConformance([subject], { mode: "full" })).rejects.toThrow(`full ${operation} positive success required`);
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
    await expect(runFulfillmentAdapterConformance([subject], { mode: "full" }), bypass).rejects.toThrow(`full ${operation} ${hint}`);
    expect(calls - baselineCalls, bypass).toBe(bypass === "always throws" ? 1 : bypass === "always returns" ? 2 : 0);
  }
});
