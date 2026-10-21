import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as entry from "../../../src/fulfillment/omnipack/index.js";
import type { OmnipackFulfillmentAdapterConfig } from "../../../src/fulfillment/omnipack/index.js";
import type { DispatchEvidence, FulfillmentDispatchRequest } from "../../../src/fulfillment/contracts/index.js";
import { config as http, jsonResponse, stock } from "./fixtures.js";

const now = "2026-10-21T10:00:00Z";
const secret = "transient-placeholder";
const plants = { token: secret, apiKey: secret, signedUrl: `https://tracking.example.test/a?signature=${secret}`, arbitrary: "recipient@example.test" };
function request(): FulfillmentDispatchRequest {
  return { requestKey: "request-a", fulfillmentRef: "fulfillment-a", orderRef: "order-a", orderNumber: "ORDER-A", parcelRef: null,
    contactRevision: { schemaVersion: 1, source: "checkout", revision: 3 },
    recipient: { name: "Example Recipient", email: "recipient@example.test", phone: "+12025550123", line1: "123 Example Street", line2: "Unit 2",
      city: "Example City", postalCode: "10001", country: "US", deliveryInstructions: "PRIVATE INSTRUCTION", courierInstructions: null },
    lines: [{ skuRef: "SKU-A", quantity: 2, title: "Example", productRef: "product-a", packRef: "pack-a" }],
    selection: { providerRef: "omnipack", carrierRef: "CARRIER-A", serviceRef: "SERVICE-A", deliveryKind: "courier", pickupPoint: null } };
}
function fixture(reply: (url: string, init?: RequestInit) => Response | Promise<Response> = () => jsonResponse({ orderId: "external-a", ...plants }), overrides: Partial<OmnipackFulfillmentAdapterConfig> = {}) {
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => reply(url.toString(), init));
  const credentials = vi.fn(() => ({ username: "example", password: secret }));
  const token = vi.fn(() => secret);
  const config: OmnipackFulfillmentAdapterConfig = { http: { ...http, safeReadRetries: 0, fetchImpl, credentials }, selected: true, readiness: { ready: true },
    resolveProduct: async () => ({ lotNumber: "LOT-A", expirationDate: "2027-01-01" }), notification: { token, expectedEvent: "order.delivered" }, clock: () => now,
    mintEvidenceReference: () => "evidence:00000000-0000-4000-8000-000000000001", mintSyncRunId: () => "sync-a", approveTrackingUrl: url => new URL(url).hostname === "tracking.example.test", ...overrides };
  return { adapter: entry.createOmnipackFulfillmentAdapter(config), fetchImpl, credentials, token, config };
}
async function prepare(adapter: ReturnType<typeof fixture>["adapter"], req: FulfillmentDispatchRequest) {
  const result = await adapter.dispatch.prepare(req);
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw Error("Expected preparation");
  return result.evidence;
}
function safe(output: unknown) {
  const serialized = JSON.stringify(output);
  for (const plant of [secret, "recipient@example.test", "Example Recipient", "123 Example Street", "PRIVATE INSTRUCTION", "signature=", '"raw"', '"body"', '"apiKey"']) expect(serialized).not.toContain(plant);
}
const reading = { providerRef: "omnipack", requestKey: "request-a", fulfillmentRef: "fulfillment-a", externalRef: "external-a", mode: "command" as const };
const webhook = (body: unknown) => ({ rawBody: Buffer.from(JSON.stringify(body)), headers: { authorization: `Bearer ${secret}` }, receivedAt: now });

it("exposes exactly two runtime symbols and an inert, unselected, unready token profile", async () => {
  expect(Object.keys(entry).sort()).toEqual(["createOmnipackFulfillmentAdapter", "omnipackFulfillmentCapabilities"]);
  const f = fixture(undefined, { selected: false, readiness: undefined });
  expect(f.adapter.capabilities).toMatchObject({ defaultOff: true, selected: false, readiness: { ready: false }, authentication: "token", freshness: "not_available", labelReadOwner: "host_storage", ownsDeliveredNotification: false, actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: true, mutationSurface: "provider_adapter" } });
  expect(f.adapter.capabilities.operations.labelRead).toEqual({ supported: false, reason: "host_only" });
  expect(f.adapter.capabilities.operations.courierPickup).toEqual({ supported: false, reason: "not_exposed" });
  expect(f.adapter).not.toHaveProperty("courierPickup");
  expect(await f.adapter.label.read({ objectRef: "object-a", mediaType: "application/pdf", externalRef: null })).toMatchObject({ kind: "refused", refusal: { reason: "unsupported" } });
  expect(entry.omnipackFulfillmentCapabilities.selected).toBe(false);
  expect((await f.adapter.dispatch.prepare(request())).kind).toBe("refused");
  const unready = fixture(undefined, { readiness: undefined });
  expect(await unready.adapter.dispatch.prepare(request())).toMatchObject({ kind: "refused", refusal: { reason: "not_ready" } });
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("explicitly refuses label create without I/O", async () => {
  const f = fixture();
  expect(f.adapter.capabilities.operations.labelCreate).toEqual({ supported: false, reason: "not_exposed" });
  expect(await f.adapter.label.create(request())).toEqual({ kind: "refused", refusal: { reason: "unsupported", phase: "dispatch", retryable: false } });
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("explicitly refuses label void without I/O", async () => {
  const f = fixture();
  expect(f.adapter.capabilities.operations.labelVoid).toEqual({ supported: false, reason: "not_exposed" });
  expect(await f.adapter.label.void({ parcelRef: "parcel-a", document: null })).toEqual({ providerDeletion: "unconfirmed", labelDeleted: false, canProceed: false, refusal: { reason: "unsupported", phase: "dispatch", retryable: false } });
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("refuses exact absence, including an empty collection, without emitting absence proof", async () => {
  const f = fixture(() => jsonResponse({ _embedded: { fulfilments: [] } }));
  expect(f.adapter.capabilities.operations.exactAbsence).toEqual({ supported: false, reason: "not_exposed" });
  expect(await f.adapter.readback.read({ ...reading, externalRef: null })).toMatchObject({ kind: "unsupported", refusal: { reason: "unsupported" } });
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(await f.adapter.readback.read(reading)).toMatchObject({ kind: "unknown" });
});
it("explicitly refuses cancellation through its unsupported declaration without offering a callable", () => {
  const f = fixture();
  expect(f.adapter.capabilities.operations.cancel).toEqual({ supported: false, reason: "not_exposed" });
  expect(f.adapter).not.toHaveProperty("cancel");
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("binds full contact revision and the exact posted bytes while excluding command PII", async () => {
  const f = fixture(); const req = request(); const evidence = await prepare(f.adapter, req);
  expect(evidence.contactRevision).toEqual(req.contactRevision);
  expect(evidence).toMatchObject({ carrierRef: "CARRIER-A", serviceRef: "SERVICE-A", providerRef: "omnipack" });
  const result = await f.adapter.dispatch.dispatch(req, structuredClone(evidence));
  expect(result).toMatchObject({ kind: "accepted", externalRef: "external-a", providerAttemptKey: expect.stringMatching(/^attempt:[a-f0-9]{64}$/u), labelKey: expect.stringMatching(/^label:[a-f0-9]{64}$/u) });
  const body = f.fetchImpl.mock.calls[0]![1]!.body as string;
  expect(evidence.commandFingerprint).toBe(createHash("sha256").update(body).digest("hex"));
  expect(JSON.parse(body).shippingDetails).toMatchObject({ carrier: "SERVICE-A", service: "SERVICE-A" });
  safe(evidence); safe(result);
  expect(await f.adapter.dispatch.dispatch(req, evidence)).toEqual(result);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});
it("refuses missing and foreign preparation before credentials or HTTP", async () => {
  const f = fixture(); const req = request();
  expect(await f.adapter.dispatch.dispatch(req, {} as DispatchEvidence)).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
  const evidence = await prepare(f.adapter, req);
  expect(await fixture().adapter.dispatch.dispatch(req, evidence)).toMatchObject({ kind: "not_dispatched" });
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("refuses every request/evidence mismatch and requires fresh prepare for a contact remap", async () => {
  for (const change of ["contact", "recipient", "line", "selection", "evidence"] as const) {
    const f = fixture(); const req = request(); const evidence = await prepare(f.adapter, req);
    const original = structuredClone(req); const validEvidence = structuredClone(evidence);
    if (change === "contact") req.contactRevision.source = "remap";
    if (change === "recipient") req.recipient.line1 = "456 Other Street";
    if (change === "line") req.lines = [{ ...req.lines[0]!, quantity: 3 }];
    if (change === "selection") req.selection.carrierRef = "CARRIER-B";
    if (change === "evidence") evidence.commandFingerprint = "0".repeat(64);
    expect(await f.adapter.dispatch.dispatch(req, evidence)).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
    expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
    Object.assign(req, original);
    expect((await f.adapter.dispatch.dispatch(req, validEvidence)).kind).toBe("accepted");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const remapped = await prepare(f.adapter, req);
    expect((await f.adapter.dispatch.dispatch(req, remapped)).kind).toBe("accepted");
  }
});
it("retains exact selection refusals and rejects missing host product metadata", async () => {
  const f = fixture();
  for (const providerRef of [null, "", "   "]) {
    const req = request(); req.selection.providerRef = providerRef;
    expect(await f.adapter.dispatch.prepare(req)).toMatchObject({ kind: "refused", refusal: { reason: "selection_required" } });
  }
  const wrong = request(); wrong.selection.providerRef = "other";
  expect(await f.adapter.dispatch.prepare(wrong)).toMatchObject({ refusal: { reason: "provider_mismatch" } });
  const missing = request(); missing.selection.serviceRef = null;
  expect(await f.adapter.dispatch.prepare(missing)).toMatchObject({ refusal: { reason: "carrier_service_required" } });
  expect(await fixture(undefined, { resolveProduct: async () => null }).adapter.dispatch.prepare(request())).toMatchObject({ refusal: { reason: "not_dispatchable" } });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("maps definitive rejection to non-submission and drops provider prose and error plants", async () => {
  const f = fixture(() => jsonResponse({ ...plants, code: "PRIVATE_PROVIDER_CODE", message: "recipient@example.test" }, 400));
  const req = request(); const result = await f.adapter.dispatch.dispatch(req, await prepare(f.adapter, req));
  expect(result).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "io_failure", phase: "dispatch", retryable: false } }); safe(result);
});
it("keeps lost/malformed acknowledgements and ambiguous POSTs unknown with one POST", async () => {
  for (const reply of [() => jsonResponse(plants), () => new Response("bad ACK"), () => jsonResponse(plants, 503), () => { throw Error(secret); }]) {
    const f = fixture(reply); const req = request(); const result = await f.adapter.dispatch.dispatch(req, await prepare(f.adapter, req));
    expect(result).toMatchObject({ kind: "unknown", effectMayHaveSucceeded: true }); safe(result); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  }
});
it("checks token before touching or parsing the body and returns only a closed refusal", async () => {
  const f = fixture(); const input = { headers: { authorization: "Bearer invalid" }, receivedAt: now, get rawBody(): Uint8Array { throw Error("body accessed before authentication"); } };
  expect(await f.adapter.observation.verifyAndNormalize(input)).toEqual({ kind: "refused", refusal: { reason: "untrusted", phase: "verify", retryable: false } });
});
it("preserves event identity across receipts, distinguishes occurrence/subject and never invents time", async () => {
  const f = fixture(); const payload = { orderId: "external-a", fulfilmentNumber: "parcel-a", ...plants };
  const first = await f.adapter.observation.verifyAndNormalize(webhook(payload));
  const retry = await f.adapter.observation.verifyAndNormalize({ ...webhook(payload), receivedAt: "2026-10-21T11:00:00Z" });
  expect(first).toMatchObject({ kind: "verified", observation: { firstReceivedAt: now, fact: { occurredAt: null, canonicalStatus: "delivered" } } });
  if (first.kind !== "verified" || retry.kind !== "verified") throw Error("Expected verification");
  expect(first.observation.eventKey).toBe(retry.observation.eventKey);
  for (const changed of [{ ...payload, orderId: "external-b" }, { ...payload, fulfilmentNumber: "parcel-b" }, { ...payload, occurredAt: now }]) {
    const result = await f.adapter.observation.verifyAndNormalize(webhook(changed));
    expect(result.kind === "verified" && result.observation.eventKey).not.toBe(first.observation.eventKey);
  }
  safe(first); safe(retry);
});
it("rejects unknown/mismatched event taxonomy, missing correlation, malformed JSON and invalid evidence pointers", async () => {
  const f = fixture();
  for (const event of ["future.delivered", "__proto__", "order.shipped", 123, false, null, {}, [], ""]) expect(await f.adapter.observation.verifyAndNormalize(webhook({ event, orderId: "external-a" }))).toMatchObject({ kind: "refused", refusal: { reason: "unsupported_event" } });
  expect(await f.adapter.observation.verifyAndNormalize(webhook({}))).toMatchObject({ refusal: { reason: "missing_correlation" } });
  expect(await f.adapter.observation.verifyAndNormalize({ ...webhook({}), rawBody: Buffer.from("{") })).toMatchObject({ refusal: { reason: "malformed" } });
  expect(await fixture(undefined, { mintEvidenceReference: () => "evidence:bad" }).adapter.observation.verifyAndNormalize(webhook({ orderId: "external-a" }))).toMatchObject({ refusal: { reason: "malformed" } });
});
it("drops unsafe and unapproved tracking URLs while retaining host-approved query-free HTTPS", async () => {
  const f = fixture();
  for (const trackingUrl of [plants.signedUrl, `https://user:${secret}@tracking.example.test/a`, "http://tracking.example.test/a", "javascript:alert(1)", "https://unapproved.example.test/a", "https://tracking.example.test/a"]) {
    const result = await f.adapter.observation.verifyAndNormalize(webhook({ orderId: "external-a", ...plants, shipments: [{ trackingNo: "TRACK-A", trackingUrl }] }));
    expect(result).toMatchObject({ kind: "verified", observation: { trackingRefs: [{ trackingNumber: "TRACK-A", publicUrl: trackingUrl === "https://tracking.example.test/a" ? trackingUrl : null }] } }); safe(result);
  }
});
it("requires positive correlated readback and refuses unknown status, duplicates and provider mismatch", async () => {
  let rows: unknown[] = [];
  const f = fixture(() => jsonResponse({ _embedded: { fulfilments: rows }, page: { number: 0, size: 100, totalPages: 1, totalElements: rows.length }, ...plants }));
  const row = { orderId: "external-a", fulfilmentNumber: "parcel-a", status: "delivered", updatedAt: now, ...plants };
  for (const invalid of [[], [{ ...row, orderId: "external-b" }], [{ ...row, status: "future_delivered" }], [row, row]]) {
    rows = invalid; expect((await f.adapter.readback.read(reading)).kind).toBe("unknown");
  }
  rows = [row]; const found = await f.adapter.readback.read(reading);
  expect(found).toMatchObject({ kind: "found", externalRef: "external-a", observation: { fact: { canonicalStatus: "delivered", occurredAt: "2026-10-21T10:00:00.000Z" } } }); safe(found);
  expect(await f.adapter.readback.read({ ...reading, providerRef: "other" })).toMatchObject({ kind: "unsupported" });
});
it("projects stock/movements with collection identity, nullable revision and closed fields", async () => {
  const f = fixture(url => jsonResponse(url.includes("stock-movements") ? { _embedded: [{ sku: "SKU-A", quantity: -2, productLotNumber: "LOT-A", expirationDate: "2027-01-01", ...plants }] } : { ...stock, ...plants }));
  const snapshots = await f.adapter.stockSync.getStock(); const movements = await f.adapter.stockSync.getStockMovements();
  expect(snapshots[0]).toMatchObject({ providerRef: "omnipack", syncRunId: "sync-a", collectedAt: "2026-10-21T10:00:00.000Z", sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", totalQuantity: 48 });
  expect(movements[0]).toMatchObject({ quantity: -2, lotRef: "LOT-A", expirationDate: "2027-01-01", occurredAt: null }); safe([snapshots, movements]);
});
it("keeps product reads pull-only and strips donor response bags from explicit writes", async () => {
  const f = fixture(() => jsonResponse({ sku: "SKU-A", packs: [{ ean: "0000000000012", quantity: 2 }, { ean: secret, quantity: 1 }], ...plants }));
  expect(await f.adapter.productSync.ensureProduct("SKU-A")).toBeNull(); expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(await f.adapter.productSync.getProductPacks("SKU-A")).toEqual([{ ean: "0000000000012", quantity: 2 }]);
  expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  const writer = fixture(undefined, { product: { resolvePushMetadata: async sku => ({ sku, title: "Example" }) } });
  const result = await writer.adapter.productSync.ensureProduct("SKU-A");
  expect(result).toEqual({ replayed: false }); safe(result);
  await writer.adapter.productSync.addProductPack("SKU-A", { ean: "0000000000012", quantity: 2 });
  expect(writer.fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
  await expect(writer.adapter.productSync.addProductPack("SKU-A", { ean: secret, quantity: 0 })).rejects.toEqual({ reason: "malformed", phase: "sync", retryable: false });
});
it("never leaks transport failures through sync or readback", async () => {
  const f = fixture(() => { throw Error(JSON.stringify(plants)); });
  for (const invoke of [() => f.adapter.stockSync.getStock(), () => f.adapter.stockSync.getStockMovements(), () => f.adapter.productSync.getProductPacks("SKU-A"), () => f.adapter.productSync.listStockedSkus()]) {
    await expect(invoke()).rejects.toEqual({ reason: "io_failure", phase: "sync", retryable: false });
  }
  const result = await f.adapter.readback.read(reading); expect(result.kind).toBe("unknown"); safe(result);
});

it("refuses unsafe host paths at construction before credentials or HTTP", () => {
  const f = fixture();
  for (const productPath of ["//other.example.test/products", "https://other.example.test/products", "//user:pass@other.example.test/products", "/\\other.example.test", "/../products", "/%2fother/products", "/products?token=a", "/products#fragment", "/products//packs"]) {
    expect(() => entry.createOmnipackFulfillmentAdapter({ ...f.config, http: { ...f.config.http, productPath } })).toThrow("Invalid fulfillment configuration");
  }
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("classifies credential and request construction failures before POST as definitive non-submission", async () => {
  for (const credentials of [() => { throw Error(secret); }, async () => { throw Error(secret); }, () => ({ get username(): string { throw Error(secret); }, password: secret })]) {
    const f = fixture(); f.config.http.credentials = credentials;
    const adapter = entry.createOmnipackFulfillmentAdapter(f.config), req = request();
    const result = await adapter.dispatch.dispatch(req, await prepare(adapter, req));
    expect(result).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "io_failure", phase: "dispatch", retryable: false } });
    safe(result); expect(f.fetchImpl).not.toHaveBeenCalled();
  }
  const f = fixture(); const req = request(); const evidence = await prepare(f.adapter, req);
  const invalidRequest = vi.spyOn(globalThis, "Request").mockImplementation(() => { throw Error(secret); });
  let result;
  try { result = await f.adapter.dispatch.dispatch(req, evidence); } finally { invalidRequest.mockRestore(); }
  expect(result).toMatchObject({ kind: "not_dispatched", effectMayHaveSucceeded: false });
  safe(result); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("keeps paginated, truncated and unproven readback collections unknown", async () => {
  const row = { orderId: "external-a", fulfilmentNumber: "parcel-a", status: "delivered" };
  for (const metadata of [{}, { page: { number: 0, size: 100, totalPages: 2, totalElements: 101 } },
    { page: { number: 0, size: 100, totalPages: 1, totalElements: 2 } },
    { page: { number: 0, size: 100, totalPages: 1, totalElements: 1 }, _links: { next: { href: "/fulfilments?page=1" } } },
    { page: { number: 0, size: 100, totalPages: 1, totalElements: 1 }, incomplete: true }]) {
    for (const rows of [[row], Array(100).fill(row), []]) {
      const f = fixture(() => jsonResponse({ _embedded: { fulfilments: rows }, ...metadata }));
      expect(await f.adapter.readback.read(reading)).toMatchObject({ kind: "unknown" });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    }
  }
});
it("fences overlapping preparations and shares in-flight and completed dispatch results", async () => {
  const releases: (() => void)[] = [];
  const f = fixture(undefined, { resolveProduct: () => new Promise(resolve => releases.push(() => resolve({ lotNumber: "LOT-A", expirationDate: "2027-01-01" }))) });
  const req = request(); const older = f.adapter.dispatch.prepare(req); const newer = f.adapter.dispatch.prepare(req);
  releases[1]!(); const current = await newer;
  if (current.kind !== "prepared") throw Error("Expected preparation");
  const [first, overlapping] = await Promise.all([f.adapter.dispatch.dispatch(req, current.evidence), f.adapter.dispatch.dispatch(req, current.evidence)]);
  expect(first.kind).toBe("accepted"); expect(overlapping).toEqual(first);
  releases[0]!(); expect(await older).toMatchObject({ kind: "refused" });
  expect(await f.adapter.dispatch.dispatch(req, current.evidence)).toEqual(first);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
  if (first.kind === "accepted") first.evidence.commandFingerprint = "mutated";
  expect(await f.adapter.dispatch.dispatch(req, current.evidence)).toEqual(overlapping);
});
