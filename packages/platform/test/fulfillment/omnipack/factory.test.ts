import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runFulfillmentProductSyncWorker } from "../../../src/fulfillment/providerProductSyncWorker.js";
import * as entry from "../../../src/fulfillment/omnipack/index.js";
import type { OmnipackFulfillmentAdapterConfig } from "../../../src/fulfillment/omnipack/index.js";
import type { DispatchEvidence, FulfillmentDispatchRequest, FulfillmentStockSyncPort, StockSnapshot, SyncCursor } from "../../../src/fulfillment/contracts/index.js";
import { runFulfillmentStockSyncWorker as run } from "../../../src/fulfillment/index.js";
import { at } from "../fixtures.js";
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
// Cross each command-bearing value with another request's already recorded evidence.
function changedCommands(req: FulfillmentDispatchRequest): FulfillmentDispatchRequest[] {
  return [
    ...(["requestKey", "fulfillmentRef", "orderRef", "orderNumber", "parcelRef"] as const)
      .map(field => ({ ...structuredClone(req), [field]: "other" })),
    ...(["schemaVersion", "source", "revision"] as const).map(field => ({ ...structuredClone(req),
      contactRevision: { ...req.contactRevision, [field]: field === "source" ? "other" : req.contactRevision[field] + 1 } })),
    ...(["name", "email", "phone", "line1", "city", "postalCode", "country"] as const)
      .map(field => ({ ...structuredClone(req), recipient: { ...req.recipient, [field]: "other" } })),
    ...(["skuRef", "productRef", "packRef", "quantity"] as const).map(field => ({ ...structuredClone(req),
      lines: [{ ...req.lines[0]!, [field]: field === "quantity" ? req.lines[0]!.quantity + 1 : "other" }] })),
    { ...structuredClone(req), lines: [...req.lines, ...req.lines] },
    ...(["providerRef", "carrierRef", "serviceRef"] as const)
      .map(field => ({ ...structuredClone(req), selection: { ...req.selection, [field]: "other" } })),
    { ...structuredClone(req), selection: { ...req.selection, deliveryKind: "parcel-locker" } },
    { ...structuredClone(req), selection: { ...req.selection, pickupPoint: { id: "other", provider: "point-provider", name: "Point",
      address: { line1: "Point Street", city: "Point City", postalCode: "10001", country: "US" } } } },
  ];
}
function frozenRequest(): FulfillmentDispatchRequest {
  const req = request();
  for (const value of [req, req.contactRevision, req.recipient, req.lines, ...req.lines, req.selection]) Object.freeze(value);
  return req;
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
const unreadableResponse = (status = 200) => new Response(new ReadableStream({ start(controller) { controller.error(Error(secret)); } }), { status });

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
  const twin = fixture();
  const evidence = await prepare(twin.adapter, request());
  expect(twin.adapter.capabilities).toMatchObject({ selected: true, readiness: { ready: true } });
  expect(entry.omnipackFulfillmentCapabilities).toMatchObject({ defaultOff: true, selected: false, readiness: { ready: false } });
  const profile = entry.omnipackFulfillmentCapabilities;
  for (const value of [profile, profile.readiness, profile.readiness.refusal, profile.operations,
    ...Object.values(profile.operations), profile.actionPolicy]) expect(Object.isFrozen(value)).toBe(true);
  for (const [inactive, reason] of [[f, "disabled"], [unready, "not_ready"]] as const) {
    expect(await inactive.adapter.dispatch.dispatch(request(), evidence)).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false,
      refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
    expect(await inactive.adapter.readback.read(reading)).toEqual({ kind: "unsupported", refusal: { reason, phase: "readback", retryable: false } });
    for (const invoke of [() => inactive.adapter.stockSync.getStock(), () => inactive.adapter.stockSync.getStockMovements(),
      () => inactive.adapter.productSync.ensureProduct("SKU-A"), () => inactive.adapter.productSync.getProductPacks("SKU-A"),
      () => inactive.adapter.productSync.addProductPack("SKU-A", { ean: "12345678", quantity: 1 }), () => inactive.adapter.productSync.listStockedSkus()]) {
      await expect(invoke()).rejects.toMatchObject({ reason, phase: "sync", retryable: false });
    }
    expect(inactive.credentials).not.toHaveBeenCalled(); expect(inactive.fetchImpl).not.toHaveBeenCalled();
  }
  expect(twin.credentials).not.toHaveBeenCalled(); expect(twin.fetchImpl).not.toHaveBeenCalled();
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
  const result = await f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(evidence));
  expect(result).toMatchObject({ kind: "accepted", externalRef: "external-a", providerAttemptKey: expect.stringMatching(/^attempt:[a-f0-9]{64}$/u), labelKey: expect.stringMatching(/^label:[a-f0-9]{64}$/u) });
  const body = f.fetchImpl.mock.calls[0]![1]!.body as string;
  expect(evidence.commandFingerprint).toBe(createHash("sha256").update(body).digest("hex"));
  expect(JSON.parse(body).shippingDetails).toMatchObject({ carrier: "SERVICE-A", service: "SERVICE-A" });
  safe(evidence); safe(result);
  expect(await prepare(f.adapter, req)).toEqual(evidence);
  expect(await f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(evidence))).toEqual(result);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});
it("rejects malformed evidence without callbacks and dispatches valid evidence without a local prepare", async () => {
  const resolveProduct = vi.fn(async () => ({ lotNumber: "LOT-A", expirationDate: "2027-01-01" }));
  const f = fixture(undefined, { resolveProduct }); const req = request();
  expect(await f.adapter.dispatch.dispatch(req, {} as DispatchEvidence)).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
  const evidence = await prepare(f.adapter, req);
  resolveProduct.mockClear();
  const fresh = fixture();
  expect(await fresh.adapter.dispatch.dispatch(req, evidence)).toEqual(await fixture().adapter.dispatch.dispatch(req, evidence));
  expect(fresh.fetchImpl).toHaveBeenCalledTimes(1);
  for (const malformed of [null, {}, { ...evidence, extra: undefined }, { ...evidence, contactRevision: { ...evidence.contactRevision, extra: undefined } }]) {
    expect(await f.adapter.dispatch.dispatch(req, malformed as DispatchEvidence)).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
  }
  expect(resolveProduct).not.toHaveBeenCalled();
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("refuses every request/evidence mismatch and requires fresh prepare for a contact remap", async () => {
  let lotNumber = "LOT-A";
  const remap = fixture(undefined, { resolveProduct: async () => ({ lotNumber }) });
  const frozen = frozenRequest(); const before = await prepare(remap.adapter, frozen);
  lotNumber = "LOT-B";
  expect(await remap.adapter.dispatch.dispatch(frozen, before)).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable" } });
  expect(remap.credentials).not.toHaveBeenCalled(); expect(remap.fetchImpl).not.toHaveBeenCalled();
  // A mismatch releases its reservation: unchanged evidence works after metadata recovers.
  lotNumber = "LOT-A";
  expect((await remap.adapter.dispatch.dispatch(frozen, before)).kind).toBe("accepted");
  expect((await remap.adapter.dispatch.dispatch(frozen, before)).kind).toBe("accepted");
  expect(remap.fetchImpl).toHaveBeenCalledTimes(1);
  for (const change of ["contact", "recipient", "line", "selection", "evidence", "orderNumber"] as const) {
    const f = fixture(); const req = request(); const evidence = await prepare(f.adapter, req);
    const original = structuredClone(req); const validEvidence = structuredClone(evidence);
    if (change === "orderNumber") req.orderNumber = "other";
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
    expect(await prepare(f.adapter, req)).toEqual(validEvidence);
    expect((await f.adapter.dispatch.dispatch(req, validEvidence)).kind).toBe("accepted");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    req.lines[0]!.title = "Changed host description";
    expect(await prepare(f.adapter, req)).toEqual(validEvidence);
    expect((await f.adapter.dispatch.dispatch(req, validEvidence)).kind).toBe("accepted");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    req.recipient.line1 = "456 Remapped Street";
    req.contactRevision.revision++;
    const remapped = await prepare(f.adapter, req);
    expect(remapped.commandFingerprint).not.toBe(validEvidence.commandFingerprint);
    expect(await f.adapter.dispatch.dispatch(req, validEvidence)).toMatchObject({ kind: "not_dispatched" });
    expect((await f.adapter.dispatch.dispatch(req, remapped)).kind).toBe("accepted");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  }
});
it("refuses same-wire different evidence after submission while preserving original cloned replay", async () => {
  for (const change of ["revision", "source", "schemaVersion", "carrierRef"] as const) {
    const f = fixture(); const req = frozenRequest(); const original = await prepare(f.adapter, req);
    const result = await f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(original));
    expect(result).toMatchObject({ kind: "accepted", evidence: original });
    for (const stale of changedCommands(req)) {
      expect(await f.adapter.dispatch.dispatch(stale, structuredClone(original))).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false,
        refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
    }
    const changed = structuredClone(req);
    if (change === "carrierRef") changed.selection.carrierRef = "CARRIER-B";
    else if (change === "source") changed.contactRevision.source = "remapped";
    else changed.contactRevision[change]++;
    const different = await prepare(f.adapter, changed);
    expect(different).not.toEqual(original); expect(different.commandFingerprint).toBe(original.commandFingerprint);
    expect(await f.adapter.dispatch.dispatch(changed, different)).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
    expect(await f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(original))).toEqual(result);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
  }
});
it("refuses same-wire different evidence in flight while joining the original cloned replay", async () => {
  for (const change of ["revision", "source", "schemaVersion", "carrierRef"] as const) {
    let enter!: () => void, finish!: (response: Response) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const f = fixture(() => { enter(); return new Promise<Response>(resolve => { finish = resolve; }); });
    const req = frozenRequest(); const original = await prepare(f.adapter, req);
    const first = f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(original));
    await entered;
    for (const stale of changedCommands(req)) {
      expect(await f.adapter.dispatch.dispatch(stale, structuredClone(original))).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false,
        refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
    }
    const changed = structuredClone(req);
    if (change === "carrierRef") changed.selection.carrierRef = "CARRIER-B";
    else if (change === "source") changed.contactRevision.source = "remapped";
    else changed.contactRevision[change]++;
    const different = await prepare(f.adapter, changed);
    expect(different).not.toEqual(original); expect(different.commandFingerprint).toBe(original.commandFingerprint);
    expect(await f.adapter.dispatch.dispatch(changed, different)).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
    const replay = f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(original));
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    finish(jsonResponse({ orderId: "external-a" }));
    const result = await first;
    expect(result).toMatchObject({ kind: "accepted", evidence: original });
    expect(await replay).toEqual(result);
    expect(await f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(original))).toEqual(result);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
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
  for (const reply of [() => jsonResponse({ ...plants, code: "PRIVATE_PROVIDER_CODE", message: "recipient@example.test" }, 400), () => unreadableResponse(400)]) {
    const f = fixture(reply); const req = request(); const evidence = await prepare(f.adapter, req);
    const result = await f.adapter.dispatch.dispatch(req, evidence);
    expect(result).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "io_failure", phase: "dispatch", retryable: false } }); safe(result);
    expect(await prepare(f.adapter, req)).toEqual(evidence);
    expect(await f.adapter.dispatch.dispatch(req, evidence)).toEqual(result);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  }
});
it("keeps lost/malformed acknowledgements and ambiguous POSTs unknown across A → B → A preparation with one POST", async () => {
  for (const reply of [() => jsonResponse(plants), () => new Response("bad ACK"), () => unreadableResponse(), () => jsonResponse(plants, 503), () => { throw Error(secret); }]) {
    let lotNumber = "LOT-A";
    const f = fixture(reply, { resolveProduct: async () => ({ lotNumber }) }); const req = frozenRequest(); const evidence = await prepare(f.adapter, req);
    const result = await f.adapter.dispatch.dispatch(req, evidence);
    expect(result).toMatchObject({ kind: "unknown", effectMayHaveSucceeded: true }); safe(result); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await f.adapter.dispatch.dispatch(req, evidence)).toEqual(result);
    expect(await prepare(f.adapter, req)).toEqual(evidence);
    expect(await f.adapter.dispatch.dispatch(req, evidence)).toEqual(result);
    lotNumber = "LOT-B";
    expect((await prepare(f.adapter, req)).commandFingerprint).not.toBe(evidence.commandFingerprint);
    expect(await f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(evidence))).toEqual(result);
    lotNumber = "LOT-A";
    expect(await prepare(f.adapter, req)).toEqual(evidence);
    expect(await f.adapter.dispatch.dispatch(req, evidence)).toEqual(result);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
  }
});
it("preserves an in-flight dispatch across unchanged and A → B → A re-preparation", async () => {
  let release!: () => void;
  const entered = new Promise<void>(resolve => { release = resolve; });
  let finish!: (response: Response) => void;
  let lotNumber = "LOT-A";
  const f = fixture(() => { release(); return new Promise<Response>(resolve => { finish = resolve; }); }, { resolveProduct: async () => ({ lotNumber }) });
  const req = frozenRequest(); const evidence = await prepare(f.adapter, req);
  const first = f.adapter.dispatch.dispatch(req, evidence);
  await entered;
  expect(await prepare(f.adapter, req)).toEqual(evidence);
  const replay = f.adapter.dispatch.dispatch(req, evidence);
  lotNumber = "LOT-B";
  expect((await prepare(f.adapter, req)).commandFingerprint).not.toBe(evidence.commandFingerprint);
  const retained = f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(evidence));
  lotNumber = "LOT-A";
  expect(await prepare(f.adapter, req)).toEqual(evidence);
  const restored = f.adapter.dispatch.dispatch(req, evidence);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  finish(jsonResponse({ orderId: "external-a" }));
  const result = await first;
  expect(result.kind).toBe("accepted"); expect(await replay).toEqual(result); expect(await restored).toEqual(result); expect(await retained).toEqual(result);
  expect(await f.adapter.dispatch.dispatch(req, evidence)).toEqual(result);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
  // r9: equivalent-wire B must retain A's result after C replaces the preparation, completed or in flight.
  for (const unknown of [false, true]) for (const inFlight of [false, true]) {
    let finish!: (response: Response) => void;
    const f = fixture(() => new Promise<Response>(resolve => { finish = resolve; }));
    const a = request(), b = request(), c = request();
    b.lines[0]!.title = "Description B"; c.lines[0]!.title = "Description C";
    const evidence = await prepare(f.adapter, a);
    const first = f.adapter.dispatch.dispatch(a, evidence);
    // Let the POST enter, without finishing its acknowledgement.
    await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledTimes(1));
    if (!inFlight) finish(unknown ? jsonResponse({}, 503) : jsonResponse({ orderId: "external-a" }));
    if (!inFlight) await first;
    expect(await prepare(f.adapter, b)).toEqual(evidence);
    const admitted = f.adapter.dispatch.dispatch(b, evidence);
    if (!inFlight) expect(await admitted).toEqual(await first);
    expect(await prepare(f.adapter, c)).toEqual(evidence);
    const replay = f.adapter.dispatch.dispatch(structuredClone(b), structuredClone(evidence));
    if (inFlight) finish(unknown ? jsonResponse({}, 503) : jsonResponse({ orderId: "external-a" }));
    const result = await first;
    expect(result.kind).toBe(unknown ? "unknown" : "accepted");
    expect(await admitted).toEqual(result); expect(await replay).toEqual(result);
    expect(await f.adapter.dispatch.dispatch(b, evidence)).toEqual(result);
    // Stateless validation still precedes replay, even when a submission exists.
    for (const invalid of [{ ...evidence, commandFingerprint: "invalid" },
      { ...evidence, contactRevision: { ...evidence.contactRevision, revision: -1 } },
      { ...evidence, carrierRef: "CARRIER-B" }, { ...evidence, serviceRef: "SERVICE-B" },
      { ...evidence, providerRef: "other" }, { ...evidence, contactRevision: { ...evidence.contactRevision, source: "other" } }]) {
      expect(await f.adapter.dispatch.dispatch(b, invalid)).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable" } });
    }
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
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
  const packs = [{ ean: "0000000000012", quantity: 2 }, { ean: "PACK-A", quantity: 0 },
    { ean: "12", quantity: 1.5 }, { ean: "NEG", quantity: -2 }, { ean: "FALLBACK", quantity: "invalid" },
    { ean: "NULL", quantity: null }, { ean: " ", quantity: 1 }, { ean: "", quantity: 2 }, { quantity: 1 }];
  const f = fixture(() => jsonResponse({ sku: "SKU-A", packs, ...plants }));
  expect(await f.adapter.productSync.ensureProduct("SKU-A")).toBeNull(); expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(await f.adapter.productSync.getProductPacks("SKU-A")).toEqual([
    { ean: "0000000000012", quantity: 2 }, { ean: "PACK-A", quantity: 0 }, { ean: "12", quantity: 1.5 },
    { ean: "NEG", quantity: -2 }, { ean: "FALLBACK", quantity: 0 }, { ean: "NULL", quantity: 0 }, { ean: " ", quantity: 1 },
  ]);
  expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  const writer = fixture(undefined, { product: { resolvePushMetadata: async sku => ({ sku, title: "Example" }) } });
  const result = await writer.adapter.productSync.ensureProduct("SKU-A");
  expect(result).toEqual({ replayed: false }); safe(result);
  await writer.adapter.productSync.addProductPack("SKU-A", { ean: "0000000000012", quantity: 2 });
  expect(writer.fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
  await expect(writer.adapter.productSync.addProductPack("SKU-A", { ean: secret, quantity: 0 })).rejects.toMatchObject({ reason: "malformed", phase: "sync", retryable: false });
});
it("never leaks transport failures through sync or readback", async () => {
  const f = fixture(() => { throw Error(JSON.stringify(plants)); });
  for (const [operation, invoke] of [
    ["get_stock", () => f.adapter.stockSync.getStock()],
    ["get_stock_movements", () => f.adapter.stockSync.getStockMovements()],
  ] as const) {
    const error = await invoke().catch(error => error);
    expect(error).toMatchObject({ reason: "io_failure", phase: "sync", retryable: true,
      providerError: { operation, status: null, code: "network_error", retryable: true } });
    safe(error);
  }
  const result = await f.adapter.readback.read(reading); expect(result.kind).toBe("unknown"); safe(result);
});
it("keeps sync failures as safe typed Errors and readback as a closed result", async () => {
  for (const status of [null, 503]) for (const code of ["FAKE_PROVIDER_DOWN", plants.arbitrary]) {
    const f = fixture(() => {
      if (status === null) throw { payload: plants };
      return jsonResponse({ code, ...plants }, status);
    });
    for (const [operation, invoke] of [
      ["getStock", () => f.adapter.stockSync.getStock()],
      ["getStockMovements", () => f.adapter.stockSync.getStockMovements()],
      ["getProduct", () => f.adapter.productSync.getProductPacks("SKU-A")],
      ["getStock", () => f.adapter.productSync.listStockedSkus()],
    ] as const) {
      const error = await invoke().catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: `OmniPack request failed: ${operation}`, reason: "io_failure", phase: "sync",
        providerFailure: true, status, code: status === null ? "network_error" : code === "FAKE_PROVIDER_DOWN" ? code : "http_503",
        retryable: true });
      safe({ message: error.message, ...error });
    }
    const result = await f.adapter.readback.read(reading); expect(result.kind).toBe("unknown"); safe(result);
  }
  const inactive = fixture(undefined, { selected: false });
  const disabled = await inactive.adapter.productSync.listStockedSkus().catch(error => error);
  expect(disabled).toBeInstanceOf(Error); expect(disabled).toMatchObject({ reason: "disabled", phase: "sync", providerFailure: false });
  const malformed = fixture(undefined, { mintSyncRunId: () => "" });
  expect(await malformed.adapter.stockSync.getStock().catch(error => error)).toMatchObject({ reason: "malformed", phase: "sync" });
  const writer = fixture(() => { throw { payload: plants }; }, { product: { resolvePushMetadata: async () => ({ sku: "SKU-A" }) } });
  for (const invoke of [() => writer.adapter.productSync.ensureProduct("SKU-A"),
    () => writer.adapter.productSync.addProductPack("SKU-A", { ean: "12345678", quantity: 1 }),
    () => writer.adapter.productSync.addProductPack("SKU-A", { ean: "", quantity: 0 })]) {
    const error = await invoke().catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.phase).toBe("sync"); safe({ message: error.message, ...error });
  }
});
it("admits donor SKUs with encoded paths, deduplicates reads and counts unsafe segments as failures", async () => {
  const skus = ["SKU/1", " SKU ?#% ", "żółć", "A".repeat(129), "SKU/1", "", " ", ".", "..", "\ud800"];
  const f = fixture(url => jsonResponse(url.endsWith("/stock")
    ? { _embedded: { stockItems: skus.map(sku => ({ sku })) } } : { packs: [] }));
  expect(await f.adapter.productSync.listStockedSkus()).toEqual([...new Set(skus.filter(sku => sku.trim()))]);
  f.fetchImpl.mockClear();
  const result = await runFulfillmentProductSyncWorker({ provider: f.adapter.productSync, mode: "pull",
    port: { listLocalProductPacks: async () => [], markPackSynced: async () => {},
      upsertPulledPack: async () => ({ replayed: false, conflict: "none" }),
      recordReconciliationEvidence: async () => ({ replayed: false }), resolveReconciliationEvidence: async () => ({ resolved: 0 }) },
    compatibility: { identity: () => ({ providerRef: "omnipack", syncRunId: "sync-a", collectedAt: now, sourceRevision: null, revisionSource: "collection" }),
      evidenceKey: () => "unused" } });
  expect(result).toMatchObject({ ok: false, pulledSkus: 4, providerCalls: 5, failures: 3, reason: "product_sync_operation_failed" });
  expect(f.fetchImpl.mock.calls.map(([url]) => url.toString())).toEqual([
    "https://warehouse.example.test/stock",
    ...skus.slice(0, 4).map(sku => `https://warehouse.example.test/products/${encodeURIComponent(sku)}`),
  ]);
  for (const sku of skus.slice(-3)) {
    const error = await f.adapter.productSync.getProductPacks(sku).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error).toMatchObject({ reason: "malformed", phase: "sync", providerFailure: false });
  }
  expect(f.fetchImpl).toHaveBeenCalledTimes(5);
});

it("refuses unsafe host paths and invalid numeric configuration at construction before credentials or HTTP", () => {
  const f = fixture();
  for (const maxRetainedSubmissions of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "1"]) {
    expect(() => entry.createOmnipackFulfillmentAdapter({ ...f.config, maxRetainedSubmissions: maxRetainedSubmissions as number })).toThrow("Invalid fulfillment configuration");
  }
  for (const field of ["timeoutMs", "safeReadRetries"] as const) {
    for (const value of [undefined, null, "1", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, ...(field === "timeoutMs" ? [0] : [])]) {
      expect(() => entry.createOmnipackFulfillmentAdapter({ ...f.config, http: { ...f.config.http, [field]: value as number } }))
        .toThrow("Invalid fulfillment configuration");
    }
  }
  for (const productPath of ["//other.example.test/products", "https://other.example.test/products", "//user:pass@other.example.test/products", "/\\other.example.test", "/../products", "/%2fother/products", "/products?token=a", "/products#fragment", "/products//packs"]) {
    expect(() => entry.createOmnipackFulfillmentAdapter({ ...f.config, http: { ...f.config.http, productPath } })).toThrow("Invalid fulfillment configuration");
  }
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("evicts oldest completed submissions and matches a fresh instance after retained re-preparation", async () => {
  for (const reply of [() => jsonResponse({ orderId: "external-a" }), () => jsonResponse({}), () => jsonResponse({}, 400)]) {
    let lotNumber = "LOT-A";
    const f = fixture(reply, { maxRetainedSubmissions: 2, resolveProduct: async () => ({ lotNumber }) });
    const req = frozenRequest();
    const submit = async (lot: string) => {
      lotNumber = lot;
      const evidence = await prepare(f.adapter, req);
      const result = await f.adapter.dispatch.dispatch(req, evidence);
      return { evidence, result };
    };
    const a = await submit("LOT-A");
    // Preparing a retained fingerprint leaves no hidden state to survive eviction.
    expect(await prepare(f.adapter, req)).toEqual(a.evidence);
    const b = await submit("LOT-B");
    // Replaying A does not refresh insertion age: C must evict A, not B.
    expect(await f.adapter.dispatch.dispatch(req, a.evidence)).toEqual(a.result);
    const c = await submit("LOT-C");
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    expect(await f.adapter.dispatch.dispatch(req, b.evidence)).toEqual(b.result);
    expect(await f.adapter.dispatch.dispatch(req, c.evidence)).toEqual(c.result);
    const fresh = entry.createOmnipackFulfillmentAdapter(f.config);
    expect(await f.adapter.dispatch.dispatch(req, a.evidence)).toEqual(await fresh.dispatch.dispatch(req, a.evidence));
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    // Both instances rebuild and POST the old evidence when callbacks match again.
    lotNumber = "LOT-A";
    const evicted = await f.adapter.dispatch.dispatch(req, a.evidence);
    const restarted = await fresh.dispatch.dispatch(req, a.evidence);
    expect(evicted).toEqual(a.result); expect(evicted).toEqual(restarted);
    expect(f.fetchImpl).toHaveBeenCalledTimes(5);
  }
  const f = fixture(undefined, { maxRetainedSubmissions: 1 });
  const invalid = request(); invalid.selection.providerRef = null;
  expect(await f.adapter.dispatch.prepare(invalid)).toMatchObject({ kind: "refused" });
  for (let i = 0; i < 8; i++) {
    const req = { ...request(), requestKey: `request-${i}`, orderRef: `order-${i}`, orderNumber: `ORDER-${i}` };
    expect((await f.adapter.dispatch.dispatch(req, await prepare(f.adapter, req))).kind).toBe("accepted");
  }
  expect(f.fetchImpl).toHaveBeenCalledTimes(8);
});
it("never evicts in-flight entries and trims overflow as soon as a submission completes", async () => {
  let lotNumber = "LOT-A";
  const releases: (() => void)[] = [];
  const f = fixture(() => new Promise(resolve => releases.push(() => resolve(jsonResponse({ orderId: "external-a" })))),
    { maxRetainedSubmissions: 1, resolveProduct: async () => ({ lotNumber }) });
  const req = frozenRequest(), a = await prepare(f.adapter, req);
  const first = f.adapter.dispatch.dispatch(req, a);
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  lotNumber = "LOT-B";
  const b = await prepare(f.adapter, req), second = f.adapter.dispatch.dispatch(req, b);
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  const joinedA = f.adapter.dispatch.dispatch(req, structuredClone(a));
  const joinedB = f.adapter.dispatch.dispatch(req, structuredClone(b));
  releases[1]!(); const resultB = await second;
  expect(await joinedB).toEqual(resultB);
  // B completes first, so it is evicted; rebuilding with changed metadata refuses.
  lotNumber = "LOT-C";
  expect(await f.adapter.dispatch.dispatch(req, b)).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable" } });
  const stillJoinedA = f.adapter.dispatch.dispatch(req, a);
  releases[0]!(); const resultA = await first;
  expect(await joinedA).toEqual(resultA); expect(await stillJoinedA).toEqual(resultA);
  expect(await f.adapter.dispatch.dispatch(req, a)).toEqual(resultA);
  expect(f.fetchImpl).toHaveBeenCalledTimes(2); expect(f.credentials).toHaveBeenCalledTimes(2);
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
it("prepares independently and joins dispatch before host resolution, credentials and POST", async () => {
  const releases: (() => void)[] = [];
  const resolveProduct = vi.fn(() => new Promise<{ lotNumber: string; expirationDate: string }>(resolve =>
    releases.push(() => resolve({ lotNumber: "LOT-A", expirationDate: "2027-01-01" }))));
  const f = fixture(undefined, { resolveProduct });
  const req = request(); const older = f.adapter.dispatch.prepare(req); const newer = f.adapter.dispatch.prepare(structuredClone(req));
  releases[1]!(); const current = await newer;
  releases[0]!(); expect(await older).toEqual(current);
  if (current.kind !== "prepared") throw Error("Expected preparation");
  const firstCall = f.adapter.dispatch.dispatch(req, current.evidence);
  const joined = f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(current.evidence));
  await vi.waitFor(() => expect(resolveProduct).toHaveBeenCalledTimes(3));
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  releases[2]!();
  const first = await firstCall, overlapping = await joined;
  expect(first.kind).toBe("accepted"); expect(overlapping).toEqual(first);
  expect(await f.adapter.dispatch.dispatch(req, current.evidence)).toEqual(first);
  expect(resolveProduct).toHaveBeenCalledTimes(3);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.credentials).toHaveBeenCalledTimes(1);
  if (first.kind === "accepted") first.evidence.commandFingerprint = "mutated";
  expect(await f.adapter.dispatch.dispatch(req, current.evidence)).toEqual(overlapping);
});

it("models stateless dispatch, command binding, replay and eviction interleavings", async () => {
  let seed = 0x6a09e667;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const refused = { kind: "not_dispatched", effectMayHaveSucceeded: false,
    refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } };
  for (let sequence = 0; sequence < 36; sequence++) {
    // Three fingerprints, each with three irrelevant descriptions and two complete evidence values.
    const pool = Array.from({ length: 18 }, (_, index) => {
      const req = request();
      req.orderNumber = `ORDER-${Math.floor(index / 6)}`;
      req.lines[0]!.title = `Description-${index % 3}`;
      req.recipient.line2 = `Unit ${index % 3}`;
      req.recipient.deliveryInstructions = `Delivery note ${index % 3}`;
      req.recipient.courierInstructions = `Courier note ${index % 3}`;
      req.selection.pickupPoint = { id: "point-a", provider: `provider-${index % 3}`, name: `Point ${index % 3}`,
        address: { line1: `Point Street ${index % 3}`, city: `City ${index % 3}`, postalCode: `1000${index % 3}`, country: `C${index % 3}` } };
      req.contactRevision.source = index % 6 < 3 ? "checkout" : "remap";
      return req;
    });
    const oracle = fixture();
    const evidence = await Promise.all(pool.map(req => prepare(oracle.adapter, req)));
    const key = (index: number) => JSON.stringify(evidence[index]);
    const fingerprint = (index: number) => evidence[index]!.commandFingerprint;
    const posts = new Map<string, number>();
    const f = fixture((_url, init) => {
      const body = init!.body as string;
      const fp = createHash("sha256").update(body).digest("hex");
      posts.set(fp, (posts.get(fp) ?? 0) + 1);
      const outcome = (Number(JSON.parse(body).orderNumber.slice(-1)) + sequence) % 3;
      return outcome === 0 ? jsonResponse({ orderId: "external-a" }) : jsonResponse({}, outcome === 1 ? 503 : 400);
    });
    type Result = Awaited<ReturnType<typeof f.adapter.dispatch.dispatch>>;
    const recorded = new Map<string, { evidenceKey: string; commandGroup: number; result: Result }>();
    const dispatch = async (indices: number[], changes: (number | undefined)[] = [], evidenceIndices = indices) => {
      const before = f.fetchImpl.mock.calls.length;
      const expected = indices.map((index, slot) => {
        const evidenceIndex = evidenceIndices[slot]!;
        const fp = fingerprint(evidenceIndex), previous = recorded.get(fp);
        // Independent oracle: each triple differs only in codec-irrelevant descriptions.
        if (previous) return previous.evidenceKey === key(evidenceIndex)
          && previous.commandGroup === Math.floor(index / 3) && changes[slot] === undefined ? previous.result : refused;
        const outcome = (Math.floor(index / 6) + sequence) % 3;
        const proof = createHash("sha256").update(JSON.stringify(["external-a", fp])).digest("hex");
        const result: Result = outcome === 0
          ? { kind: "accepted", externalRef: "external-a", evidence: evidence[index]!, providerAttemptKey: `attempt:${proof}`, labelKey: `label:${proof}` }
          : outcome === 1 ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: false } }
            : { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "io_failure", phase: "dispatch", retryable: false } };
        recorded.set(fp, { evidenceKey: key(index), commandGroup: Math.floor(index / 3), result });
        return result;
      });
      const results = await Promise.all(indices.map((index, slot) => {
        const req = changes[slot] === undefined ? structuredClone(pool[index]!) : changedCommands(pool[index]!)[changes[slot]!]!;
        return f.adapter.dispatch.dispatch(req, structuredClone(evidence[evidenceIndices[slot]!]!));
      }));
      expect(results, `sequence ${sequence}, indices ${indices}`).toEqual(expected);
      expect(f.fetchImpl.mock.calls.length - before).toBe(recorded.size - before);
      expect(f.fetchImpl).toHaveBeenCalledTimes(recorded.size);
      expect(f.credentials).toHaveBeenCalledTimes(recorded.size);
      for (const count of posts.values()) expect(count).toBe(1);
    };
    // Seeded equivalent-wire triple: the old implementation loses B after prepare(C).
    const a = random(3), b = (a + 1) % 3, c = (a + 2) % 3;
    await prepare(f.adapter, pool[a]!); await dispatch([a]);
    await prepare(f.adapter, pool[b]!); await dispatch([b]);
    await prepare(f.adapter, pool[c]!); await dispatch([b]);
    // All HTTP outcomes are recorded before crossed replay; exercise every changed
    // field both while a new submission joins in flight and after it completes.
    const variantCount = changedCommands(pool[a]!).length;
    for (const index of [6, 12]) {
      await prepare(f.adapter, pool[index]!);
      await dispatch([index, ...Array<number>(variantCount).fill(index)], [undefined, ...Array.from({ length: variantCount }, (_, i) => i)]);
    }
    for (const index of [a, 6, 12]) {
      await dispatch(Array<number>(variantCount).fill(index), Array.from({ length: variantCount }, (_, i) => i));
    }
    for (let step = 0; step < 96; step++) {
      const index = random(pool.length), operation = random(5);
      if (operation === 0) {
        const before = f.fetchImpl.mock.calls.length;
        expect(await prepare(f.adapter, pool[index]!)).toEqual(evidence[index]);
        expect(f.fetchImpl).toHaveBeenCalledTimes(before);
      } else if (operation === 1) await dispatch([index]);
      else if (operation === 3) await dispatch([index], [random(variantCount)]);
      else if (operation === 4) await dispatch([index], [], [random(pool.length)]);
      else {
        const group = Math.floor(index / 6) * 6;
        // Join an in-flight equivalent description and refuse the other evidence value.
        const equivalent = group + Math.floor((index % 6) / 3) * 3 + (index + 1) % 3;
        const different = group + ((index % 6) + 3) % 6;
        await dispatch([index, equivalent, different, index]);
      }
    }
    expect(recorded.size).toBe(3);
    // Independent retention oracle varies distinct request identities. There is
    // no preparation model: every absent fingerprint rebuilds and may POST.
    const bounded = fixture((_url, init) => {
      const outcome = (Number(JSON.parse(init!.body as string).orderNumber.slice(-1)) + sequence) % 3;
      return outcome === 0 ? jsonResponse({ orderId: "external-a" }) : jsonResponse({}, outcome === 1 ? 503 : 400);
    }, { maxRetainedSubmissions: 2 });
    const requests = Array.from({ length: 5 }, (_, i) => ({ ...request(),
      requestKey: `request-${i}`, fulfillmentRef: `fulfillment-${i}`, orderRef: `order-${i}`, orderNumber: `ORDER-${i}` }));
    const proofs = await Promise.all(requests.map(req => prepare(oracle.adapter, req)));
    const retained = new Map<string, Result>();
    let expectedPosts = 0, evictions = 0;
    const boundedDispatch = async (index: number) => {
      const req = requests[index]!, e = proofs[index]!, fp = e.commandFingerprint;
      let expected = retained.get(fp);
      if (!expected) {
        const outcome = (index + sequence) % 3;
        const proof = createHash("sha256").update(JSON.stringify(["external-a", fp])).digest("hex");
        expected = outcome === 0
          ? { kind: "accepted", externalRef: "external-a", evidence: e, providerAttemptKey: `attempt:${proof}`, labelKey: `label:${proof}` }
          : outcome === 1 ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: false } }
            : { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "io_failure", phase: "dispatch", retryable: false } };
        expectedPosts++;
        retained.set(fp, expected);
        if (retained.size > 2) { retained.delete(retained.keys().next().value!); evictions++; }
      }
      expect(await Promise.all([bounded.adapter.dispatch.dispatch(req, e),
        bounded.adapter.dispatch.dispatch(structuredClone(req), structuredClone(e))])).toEqual([expected, expected]);
      expect(bounded.fetchImpl).toHaveBeenCalledTimes(expectedPosts);
      expect(bounded.credentials).toHaveBeenCalledTimes(expectedPosts);
      // Cross a changed command with retained evidence: explicit no-I/O refusal.
      expect(await bounded.adapter.dispatch.dispatch({ ...req, requestKey: "crossed" }, e)).toEqual(refused);
      expect(bounded.fetchImpl).toHaveBeenCalledTimes(expectedPosts);
    };
    for (let step = 0; step < 32; step++) {
      const index = step < 5 ? step : random(requests.length);
      expect(await prepare(bounded.adapter, requests[index]!)).toEqual(proofs[index]);
      await boundedDispatch(index);
      // Retained prepare must not influence subsequent eviction or replay.
      expect(await prepare(bounded.adapter, requests[index]!)).toEqual(proofs[index]);
      if (step % 4 === 3) for (let old = 0; old < requests.length; old++) await boundedDispatch(old);
    }
    expect(evictions).toBeGreaterThan(0);
  }
});

function stockFixture() {
  let cursor: SyncCursor | null = null, fail = false;
  const evidence: Parameters<FulfillmentStockSyncPort["recordLowStockEvidence"]>[0][] = [], snapshots: Parameters<FulfillmentStockSyncPort["recordStockSnapshot"]>[0][] = [], requested: string[] = [], resolutions: Parameters<FulfillmentStockSyncPort["resolveLowStockEvidence"]>[0][] = [];
  const stock: StockSnapshot = { providerRef: "warehouse-a", syncRunId: "legacy-run", collectedAt: at, sourceRevision: null, revisionSource: "collection", skuRef: "sku-a", quantityKind: "snapshot", totalQuantity: 9, forSaleQuantity: 5, reservedOrUnavailableQuantity: 4 };
  const line: Awaited<ReturnType<FulfillmentStockSyncPort["readLocalInventoryStock"]>>[number] = { skuRef: "sku-a", quantity: { onHand: 10, reserved: 2, unavailable: 1, safetyStock: 0 }, fulfillable: true, locationStatus: "active", lotStatus: "available", expiresAt: null };
  const lines = [line];
  const input: Parameters<typeof run>[0] = {
    now: () => new Date(at), movementBatchSize: 20,
    compatibility: { syncRunId: () => "legacy-stock-run", staleEvidenceSku: "legacy-sentinel", timeZone: "Etc/GMT-2", currentKey: (r, s) => `${r}:current:${s}`, snapshotKey: (r, s) => `${r}:snapshot:${s}`, lowStockKey: (s, t) => `legacy:${s}:${t}`, staleKey: last => `legacy-stale:${last}` },
    provider: { async getStock() { return [stock]; }, async getStockMovements() { return []; } },
    port: { async readCursor() { return cursor; }, async readLocalInventoryStock(requestedAt) { requested.push(requestedAt); return lines; },
      async readSkuInventoryClasses() { return new Map([["sku-a", "sellable"]]); }, async readActiveReservations(_skus, requestedAt) { requested.push(requestedAt); return new Map([["sku-a", 6]]); },
      async recordCursor(value) { cursor = structuredClone(value); },
      async recordStockSnapshot(value) { snapshots.push(value); if (fail) throw new Error("synthetic-private-stock"); return { replayed: false, readBack: true }; },
      async recordProviderStockCurrent() { return { replayed: false, readBack: true }; }, async recordMovement() { return { replayed: false, readBack: false }; },
      async recordLowStockEvidence(value) { evidence.push(value); return { replayed: false }; }, async resolveLowStockEvidence(value) { resolutions.push(value); return { resolved: 1 }; },
    },
  };
  return { input, lines, evidence, snapshots, requested, resolutions, cursor: () => cursor, setCursor(value: SyncCursor | null) { cursor = value; }, fail(value: boolean) { fail = value; } };
}

// Inputs reused from b3 probe stock scenarios: total9/forSale5, local10/2/1/1,
// activeReservations6, 22:30Z, two read attempts and a 5ms timeout. No provider access.
const probeAt = "2026-10-22T22:30:00.000Z";
const probeStock = { sku: "sku-a", totalQuantity: 9, forSaleQuantity: 5 };
function probe(reply?: (url: URL, init?: RequestInit) => Promise<Response> | Response) {
  const f = stockFixture(), calls: { url: URL; init?: RequestInit }[] = [];
  f.input.now = () => new Date(probeAt);
  f.lines[0].quantity.safetyStock = 1;
  f.input.compatibility.syncRunId = date => `stock-run:${date.toISOString()}`;
  f.input.provider = entry.createOmnipackFulfillmentAdapter({
    http: { ...http, timeoutMs: 5, fetchImpl: (async (url, init) => {
      const target = new URL(String(url)); calls.push({ url: target, init });
      return reply ? reply(target, init) : jsonResponse(target.pathname === "/stock"
        ? { _embedded: { stockItems: [probeStock] } } : { _embedded: [] });
    }) as typeof fetch },
    selected: true, readiness: { ready: true }, resolveProduct: async () => null,
    notification: { token: () => "placeholder", expectedEvent: "order.delivered" },
    clock: () => probeAt, mintEvidenceReference: () => "evidence:probe", mintSyncRunId: () => "provider-run",
    approveTrackingUrl: () => false,
  }).stockSync;
  return { ...f, calls };
}

it("keeps the safe per-item failure in the result and failed cursor (S1 stock-local-error)", async () => {
  const f = probe();
  f.input.port.recordStockSnapshot = async () => { throw Error("snapshot_write_failed:23505"); };
  const result = await run(f.input);
  expect(result).toMatchObject({ ok: false, failures: 1, checked: 0, reason: "snapshot_write_failed:23505",
    items: [{ skuRef: "sku-a", status: "failed", reason: "snapshot_write_failed:23505" }] });
  expect(f.cursor()).toMatchObject({ status: "failed", error: { reason: result.reason }, counts: { failures: 1 } });
});

it("keeps a transient snapshot failure retryable alongside a rejected SKU (S1/S5)", async () => {
  const f = probe(url => jsonResponse(url.pathname === "/stock"
    ? { _embedded: { stockItems: [{ ...probeStock, sku: "SKU/1" }, probeStock] } } : { _embedded: [] }));
  f.input.port.recordStockSnapshot = async () => { throw Object.assign(Error("private payload"), { code: "40001" }); };
  expect(await run(f.input)).toMatchObject({ ok: false, failures: 2, rejected: 1, reason: "snapshot_write_failed:40001",
    items: [{ kind: "stock", itemIndex: 0, skuRef: null, status: "rejected", reason: "invalid_sku_ref" },
      { itemIndex: 1, skuRef: "sku-a", status: "failed", reason: "snapshot_write_failed:40001" }] });
  expect(f.cursor()).toMatchObject({ status: "failed", counts: { failures: 2, rejected: 1 },
    error: { reason: "snapshot_write_failed:40001" }, refusal: { reason: "io_failure", retryable: true } });
  expect(JSON.stringify(f.cursor())).not.toMatch(/SKU\/1|private payload/);
});

it("keeps a SQLSTATE but excludes arbitrary exception prose and payloads (S1)", async () => {
  const f = probe();
  f.input.port.recordStockSnapshot = async () => { throw Object.assign(Error("https://private.invalid/?token=secret recipient@example.test"), { code: "42P01" }); };
  expect(await run(f.input)).toMatchObject({ reason: "snapshot_write_failed:42P01" });
  expect(JSON.stringify(f.cursor())).not.toMatch(/secret|private.invalid|recipient@example/);
  f.input.port.recordStockSnapshot = async () => { throw Error("secret_payload_value"); };
  expect(await run(f.input)).toMatchObject({ reason: "snapshot_write_failed" });
});

it("persists operation/status/code/retryability after exhausted provider 503 reads (S2 stock-503)", async () => {
  const f = probe(() => jsonResponse({ code: "FAKE_PROVIDER_DOWN", token: "secret" }, 503));
  const providerError = { operation: "get_stock", status: 503, code: "FAKE_PROVIDER_DOWN", retryable: true };
  expect(await run(f.input)).toMatchObject({ ok: false, failures: 1, providerCalls: 1, providerError });
  expect(f.calls).toHaveLength(2);
  expect(f.cursor()).toMatchObject({ status: "failed", error: { providerError }, refusal: { retryable: true } });
  expect(JSON.stringify(f.cursor())).not.toContain("secret");
});

it("retains timeout retryability after the final attempt (S2 stock-timeout)", async () => {
  const f = probe((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("scripted timeout secret", "AbortError")), { once: true });
  }));
  expect(await run(f.input)).toMatchObject({ ok: false, providerError: { operation: "get_stock", status: null, code: "network_error", retryable: true } });
  expect(f.calls).toHaveLength(2);
  expect(f.cursor()).toMatchObject({ status: "failed", refusal: { retryable: true } });
});

it("names redirect refusal and makes one GET attempt while preserving the credential destination policy (S2)", async () => {
  for (const httpRedirect of [false, true]) {
    const f = probe((_url, init) => {
      expect(init?.redirect).toBe("error");
      if (httpRedirect) return jsonResponse({}, 302);
      throw new TypeError("fetch failed", { cause: Error("unexpected redirect") });
    });
    expect(await run(f.input)).toMatchObject({ providerError: { code: "redirect_refused", retryable: false } });
    expect(f.cursor()).toMatchObject({ status: "failed", error: { providerError: { code: "redirect_refused" } } });
    expect(f.calls).toHaveLength(1);
  }
});

it("distinguishes movement-read failures and sanitizes unsafe provider error codes (S2)", async () => {
  const f = probe(url => url.pathname === "/stock" ? jsonResponse({ _embedded: { stockItems: [{ ...probeStock, sku: "SKU/1" }, probeStock] } })
    : jsonResponse({ code: "https://private.invalid/?token=secret" }, 400));
  expect(await run(f.input)).toMatchObject({ ok: false, rejected: 1, failures: 2, reason: "provider_get_stock_movements_failed:http_400",
    providerError: { operation: "get_stock_movements", status: 400, code: "http_400", retryable: false } });
  expect(f.cursor()).toMatchObject({ status: "failed", error: { reason: "provider_get_stock_movements_failed:http_400" },
    refusal: { reason: "io_failure", retryable: false }, counts: { providerCalls: 2 } });
  expect(JSON.stringify(f.cursor())).not.toContain("secret");
});

it("retries a transient read and completes with no failed-provider diagnostic (S2 stock-retry)", async () => {
  let stockReads = 0;
  const f = probe(url => url.pathname === "/stock"
    ? ++stockReads === 1 ? jsonResponse({ code: "FAKE_PROVIDER_DOWN" }, 503) : jsonResponse({ _embedded: { stockItems: [probeStock] } })
    : jsonResponse({ _embedded: [] }));
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 1, updated: 2 });
  expect(f.calls).toHaveLength(3);
  expect(f.cursor()).toMatchObject({ status: "succeeded", error: null });
});

it("persists run, ATP and stale/shortage evidence using cursor JSON (S3 stock-stale/stock-gap)", async () => {
  const f = probe();
  f.setCursor({ status: "succeeded", lastStockSyncedAt: "2026-10-22T00:00:00.000Z", lastMovementOccurredAt: null,
    continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, coverageGapSkus: ["sku-a"], refusal: null });
  expect(await run(f.input)).toMatchObject({ ok: true, lowStock: 2, reservationCoverage: 1 });
  expect(f.cursor()).toMatchObject({ syncRunId: `stock-run:${probeAt}`, counts: { checked: 1, updated: 2, movements: 0 },
    staleSync: { gapHours: 22.5, thresholdHours: 6, detectedAt: probeAt },
    items: [{ skuRef: "sku-a", activeReserved: 6, sellableNow: 0, coverageGapQuantity: 1 }],
    alerts: [expect.objectContaining({ thresholdKind: "stale_sync", gapHours: 22.5, detectedAt: probeAt }),
      expect.objectContaining({ thresholdKind: "safety_stock", activeReserved: 6, coverageGapQuantity: 1 }),
      expect.objectContaining({ thresholdKind: "reservation_coverage", activeReserved: 6, coverageGapQuantity: 1 })] });
});

it("round-trips cursor counts, item/alert evidence and safe provider errors through the native JSON column (S1–S3)", async () => {
  const f = probe(() => jsonResponse({ code: "FAKE_PROVIDER_DOWN" }, 503)); await run(f.input);
  const { createPostgresFulfillmentStockSyncPort } = await import("../../../src/fulfillment/postgresStockSyncPort.js");
  let values: unknown[] = [];
  const port = createPostgresFulfillmentStockSyncPort({ async query(sql, input = []) {
    if (sql.startsWith("INSERT")) { values = input; return { rows: [] }; }
    return { rows: [{ status: values[1], last_stock_synced_at: values[2], last_movement_occurred_at: values[3], cursor: JSON.parse(String(values[4])) }] };
  } }, { sourceKey: "warehouse-a", readLocalInventoryStock: async () => [] });
  await port.recordCursor(f.cursor()!);
  expect(await port.readCursor()).toEqual(f.cursor());
  expect(values[5]).toBe("provider_get_stock_failed:FAKE_PROVIDER_DOWN");
  const healthy = probe(); await run(healthy.input); await port.recordCursor(healthy.cursor()!);
  expect(await port.readCursor()).toEqual(healthy.cursor());
});

it("admits valid rows while counting and reporting every unsafe SKU by index (S5 stock-slash)", async () => {
  const f = probe(url => jsonResponse(url.pathname === "/stock" ? { _embedded: { stockItems: [
    { ...probeStock, sku: "SKU/1" }, probeStock, { ...probeStock, sku: "https://private.invalid/?token=secret" },
  ] } } : { _embedded: [] }));
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 1, updated: 2, failures: 2, rejected: 2,
    items: expect.arrayContaining([{ kind: "stock", itemIndex: 0, skuRef: null, status: "rejected", reason: "invalid_sku_ref" },
      { kind: "stock", itemIndex: 2, skuRef: null, status: "rejected", reason: "invalid_sku_ref" }, expect.objectContaining({ itemIndex: 1, skuRef: "sku-a", status: "recorded" })]) });
  expect(f.snapshots.map(value => value.snapshot.skuRef)).toEqual(["sku-a"]);
  expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: probeAt, counts: { rejected: 2 }, refusal: null, error: null });
  expect(JSON.stringify(f.cursor())).not.toMatch(/SKU\/1|secret|private.invalid/);
});

it("reports entirely rejected stock, movement or combined batches as malformed and non-retryable (S5)", async () => {
  for (const source of ["stock", "movement", "both"]) {
    const f = probe(url => jsonResponse(url.pathname === "/stock"
      ? { _embedded: { stockItems: source === "movement" ? [] : [{ ...probeStock, sku: "SKU/1" }] } }
      : { _embedded: source === "stock" ? [] : [{ sku: "SKU/1", quantity: 2, occurredAt: probeAt }] }));
    const rejected = source === "both" ? 2 : 1;
    expect(await run(f.input)).toMatchObject({ ok: false, checked: 0, updated: 0, rejected, failures: rejected, reason: "invalid_sku_ref" });
    expect(f.snapshots).toEqual([]);
    expect(f.cursor()).toMatchObject({ status: "failed", lastStockSyncedAt: null, error: { reason: "invalid_sku_ref" }, coverageGapSkus: [], refusal: { reason: "malformed", retryable: false } });
  }
});

it("reports unsafe stock and movement rows while preserving valid observations (S5)", async () => {
  const movement = { sku: "sku-a", quantity: 2, occurredAt: probeAt, operationType: "receipt", warehouseDocumentNumber: "DOC-A" };
  const f = probe(url => jsonResponse(url.pathname === "/stock"
    ? { _embedded: { stockItems: [probeStock, { ...probeStock, sku: "SKU/1" }] } }
    : { _embedded: [movement, { ...movement, sku: "SKU/1", occurredAt: "2026-10-22T23:00:00.000Z" }] }));
  const current = vi.fn(f.input.port.recordProviderStockCurrent);
  const recordMovement = vi.fn(f.input.port.recordMovement);
  f.input.port.recordProviderStockCurrent = current;
  f.input.port.recordMovement = recordMovement;
  const result = await run(f.input);
  const rejection = { itemIndex: 1, skuRef: null, status: "rejected", reason: "invalid_sku_ref" };
  expect(result).toMatchObject({ ok: true, checked: 1, updated: 2, movements: 1, lastMovementOccurredAt: probeAt,
    rejected: 2, failures: 2 });
  expect(result.items.filter(item => item.status === "rejected")).toEqual([{ ...rejection, kind: "stock" }, { ...rejection, kind: "movement" }]);
  expect(result.items).toContainEqual(expect.objectContaining({ skuRef: "sku-a", status: "recorded" }));
  expect(result.providerError).toBeUndefined();
  expect(f.snapshots.map(value => value.snapshot.skuRef)).toEqual(["sku-a"]);
  expect(current.mock.calls.map(([value]) => value.snapshot.skuRef)).toEqual(["sku-a"]);
  expect(recordMovement).not.toHaveBeenCalled();
  expect(f.cursor()).toMatchObject({ counts: { checked: 1, updated: 2, movements: 1, rejected: 2, failures: 2 },
    status: "succeeded", lastStockSyncedAt: probeAt, error: null, refusal: null });
  expect(JSON.stringify(f.cursor())).not.toMatch(/SKU\/1|provider_read_failed/);
  // A valid movement also keeps a batch successful when every stock row is rejected.
  f.input.provider.getStock = async () => [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref" }];
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 0, movements: 1, rejected: 2 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: probeAt, error: null, refusal: null });
});

it("preserves duplicate rows and movement counts/window evidence (S3 stock-duplicate/stock-movements)", async () => {
  const f = probe(url => jsonResponse(url.pathname === "/stock" ? { _embedded: { stockItems: [probeStock, probeStock] } }
    : { _embedded: [{ sku: "sku-a", quantity: 2, occurredAt: probeAt, operationType: "receipt", warehouseDocumentNumber: "DOC-A" },
      { sku: "sku-a", quantity: 2, occurredAt: probeAt, operationType: "receipt", warehouseDocumentNumber: "DOC-A" }] }));
  expect(await run(f.input)).toMatchObject({ checked: 2, movements: 2, lastMovementOccurredAt: probeAt });
  expect(f.cursor()).toMatchObject({ counts: { checked: 2, movements: 2 }, lastMovementOccurredAt: probeAt });
  expect(f.calls[1].url.searchParams.get("startLocalDate")).toBe("2026-10-22");
});

it("records a terminal failure when alert persistence fails after item writes (S1/S4)", async () => {
  const f = probe();
  f.input.port.recordLowStockEvidence = async () => { throw Object.assign(Error("private payload"), { code: "23505" }); };
  expect(await run(f.input)).toMatchObject({ ok: false, checked: 1, failures: 1, reason: "stock_evidence_write_failed:23505" });
  expect(f.cursor()).toMatchObject({ status: "failed", coverageGapSkus: [], error: { reason: "stock_evidence_write_failed:23505" } });
});
