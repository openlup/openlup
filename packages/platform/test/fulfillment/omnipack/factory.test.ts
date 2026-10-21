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
it("refuses missing and foreign preparation before credentials or HTTP", async () => {
  const f = fixture(); const req = request();
  expect(await f.adapter.dispatch.dispatch(req, {} as DispatchEvidence)).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
  const evidence = await prepare(f.adapter, req);
  expect(await fixture().adapter.dispatch.dispatch(req, evidence)).toMatchObject({ kind: "not_dispatched" });
  for (const malformed of [null, {}, { ...evidence, extra: undefined }, { ...evidence, contactRevision: { ...evidence.contactRevision, extra: undefined } }]) {
    expect(await f.adapter.dispatch.dispatch(req, malformed as DispatchEvidence)).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
  }
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("refuses every request/evidence mismatch and requires fresh prepare for a contact remap", async () => {
  let lotNumber = "LOT-A";
  const remap = fixture(undefined, { resolveProduct: async () => ({ lotNumber }) });
  const frozen = frozenRequest(); const before = await prepare(remap.adapter, frozen);
  lotNumber = "LOT-B";
  const after = await prepare(remap.adapter, frozen);
  expect(after.commandFingerprint).not.toBe(before.commandFingerprint);
  expect(await remap.adapter.dispatch.dispatch(frozen, before)).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable" } });
  expect(remap.credentials).not.toHaveBeenCalled(); expect(remap.fetchImpl).not.toHaveBeenCalled();
  expect((await remap.adapter.dispatch.dispatch(frozen, after)).kind).toBe("accepted");
  expect((await remap.adapter.dispatch.dispatch(frozen, after)).kind).toBe("accepted");
  expect(remap.fetchImpl).toHaveBeenCalledTimes(1);
  for (const change of ["contact", "recipient", "line", "selection", "evidence", "requestKey", "fulfillmentRef", "orderRef", "orderNumber", "parcelRef"] as const) {
    const f = fixture(); const req = request(); const evidence = await prepare(f.adapter, req);
    const original = structuredClone(req); const validEvidence = structuredClone(evidence);
    if (change === "requestKey" || change === "fulfillmentRef" || change === "orderRef" || change === "orderNumber" || change === "parcelRef") req[change] = "other";
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

it("refuses unsafe host paths and invalid retention caps at construction before credentials or HTTP", () => {
  const f = fixture();
  for (const maxRetainedSubmissions of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "1"]) {
    expect(() => entry.createOmnipackFulfillmentAdapter({ ...f.config, maxRetainedSubmissions: maxRetainedSubmissions as number })).toThrow("Invalid fulfillment configuration");
  }
  for (const productPath of ["//other.example.test/products", "https://other.example.test/products", "//user:pass@other.example.test/products", "/\\other.example.test", "/../products", "/%2fother/products", "/products?token=a", "/products#fragment", "/products//packs"]) {
    expect(() => entry.createOmnipackFulfillmentAdapter({ ...f.config, http: { ...f.config.http, productPath } })).toThrow("Invalid fulfillment configuration");
  }
  expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("bounds submission and preparation retention without evicting recorded replay at capacity", async () => {
  for (const reply of [() => jsonResponse({ orderId: "external-a" }), () => jsonResponse({}), () => jsonResponse({}, 400)]) {
    let lotNumber = "LOT-A";
    const f = fixture(reply, { maxRetainedSubmissions: 1, resolveProduct: async () => ({ lotNumber }) });
    const req = frozenRequest(); const original = await prepare(f.adapter, req);
    // A second unsubmitted evidence key cannot grow the preparation map past its cap.
    lotNumber = "LOT-B";
    expect(await f.adapter.dispatch.prepare(req)).toEqual({ kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } });
    lotNumber = "LOT-A";
    await prepare(f.adapter, req);
    const result = await f.adapter.dispatch.dispatch(req, original);
    f.fetchImpl.mockClear(); f.credentials.mockClear();
    // The submitted preparation is released, but the submission result is never evicted.
    lotNumber = "LOT-B";
    const different = await prepare(f.adapter, req);
    expect(different.commandFingerprint).not.toBe(original.commandFingerprint);
    expect(await f.adapter.dispatch.dispatch(req, different)).toEqual({ kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
    // A new request digest cannot grow the generation map past its cap either.
    expect(await f.adapter.dispatch.prepare({ ...req, requestKey: "other" })).toEqual({ kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } });
    expect(await f.adapter.dispatch.dispatch(structuredClone(req), structuredClone(original))).toEqual(result);
    expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  }
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
  const req = request(); const older = f.adapter.dispatch.prepare(req); const newer = f.adapter.dispatch.prepare(structuredClone(req));
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

it("models seeded preparation, replay and concurrent interleavings from the submission record", async () => {
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
      const first = indices[0]!;
      // New submissions are explicitly prepared; replays deliberately do not depend on preparation.
      if (!recorded.has(fingerprint(first))) await prepare(f.adapter, pool[first]!);
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
    // Missing preparation is a refusal, with no submission or I/O.
    expect(await f.adapter.dispatch.dispatch(pool[0]!, evidence[0]!)).toEqual(refused);
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.credentials).not.toHaveBeenCalled();
    // Seeded equivalent-wire triple: the old implementation loses B after prepare(C).
    const a = random(3), b = (a + 1) % 3, c = (a + 2) % 3;
    await dispatch([a]); await prepare(f.adapter, pool[b]!); await dispatch([b]);
    await prepare(f.adapter, pool[c]!); await dispatch([b]);
    // All HTTP outcomes are recorded before crossed replay; exercise every changed
    // field both while a new submission joins in flight and after it completes.
    const variantCount = changedCommands(pool[a]!).length;
    for (const index of [6, 12]) {
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
  }
});
