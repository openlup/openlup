import { expect, it, vi } from "vitest";
import { createOmnipackFulfillmentAdapter, type OmnipackFulfillmentAdapterConfig } from "../../../src/fulfillment/omnipack/index.js";
import { fulfillmentIngressHttpResult as httpResult, verifyAndNormalizeFulfillmentObservation as run, reconcileFulfillmentObservations, createPostgresFulfillmentShipmentSpinePort } from "../../../src/fulfillment/index.js";
import { ingressFixture, at } from "../fixtures.js";
import { config as http } from "./fixtures.js";

const eventKey = "order.shipped:external-a:parcel-a:2026-10-21T10:00:00+02:00";
const payload = () => ({ event: "order.shipped", orderId: "external-a", fulfilmentNumber: "parcel-a", occurredAt: "2026-10-21T10:00:00+02:00",
  shipments: [{ trackingNo: "TRACK-A", carrier: "CARRIER-A", shippingMethod: "CARRIER-A_SERVICE", trackingUrl: "https://tracking.invalid/a" }] });
// The adopter explicitly admits these additional incumbent references, not arbitrary prose.
const incumbentReference = (value: string) => /^(?:external\/a b|TRACK A|TRACK\/B)$/u.test(value.trim())
  || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
function fixture(body: unknown = payload(), overrides: Partial<OmnipackFulfillmentAdapterConfig> = {}) {
  const fetchImpl = vi.fn(() => { throw Error("unexpected_provider_call"); });
  const adapter = createOmnipackFulfillmentAdapter({ http: { ...http, fetchImpl }, notification: { token: () => "placeholder", expectedEvent: "order.shipped" },
    resolveProduct: async () => null, clock: () => at, mintSyncRunId: () => "sync-a",
    mintEvidenceReference: () => "evidence:00000000-0000-4000-8000-000000000001", approveTrackingUrl: url => new URL(url).hostname === "tracking.invalid", ...overrides });
  const f = ingressFixture();
  f.input.provider = adapter.observation;
  f.input.approveTrackingUrl = url => new URL(url).hostname === "tracking.invalid";
  f.input.observationCodecs = overrides.observationCodecs;
  f.input.verification = { rawBody: Buffer.from(JSON.stringify(body)), headers: { authorization: "Bearer placeholder" }, receivedAt: at };
  f.input.lifecycle.keys = { stock: ref => `omnipack:webhook:${ref}:provider-stock-consumed`, handoff: ref => `omnipack:webhook:${ref}:handoff`, tracking: (key, number) => `omnipack:webhook:${key}:tracking:${number}` };
  return { ...f, fetchImpl, adapter };
}

it("maps disabled/auth/route/malformed refusals and accepted receipts into safe HTTP classes (O1)", async () => {
  const f = fixture();
  for (const [input, expected] of [
    [{ ...f.input, enabled: false }, { status: 503, messageClass: "upstream_unavailable" }],
    [{ ...f.input, verification: { ...f.input.verification, headers: {} } }, { status: 403, messageClass: "forbidden" }],
    [fixture({ event: "order.delivered" }).input, { status: 400, messageClass: "bad_request" }],
    [fixture([]).input, { status: 400, messageClass: "bad_request" }],
  ] as const) {
    const result = await run(input);
    expect(result).toMatchObject({ kind: "refused", receiptId: null }); expect(httpResult(result)).toEqual(expected);
  }
  f.input.localPersistence.recordObservation = async () => ({ replayed: false, receiptId: "receipt-host-a" });
  const result = await run(f.input);
  expect(result).toMatchObject({ kind: "processed", receiptId: "receipt-host-a" });
  expect(httpResult(result)).toEqual({ status: 200, messageClass: "accepted" });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

it("keeps donor colon event bytes and original occurrence distinct from normalized fact identity (O2/O3)", async () => {
  const f = fixture(); const result = await run(f.input);
  expect(result).toMatchObject({ receiptId: eventKey, observation: { eventKey, fact: { occurredAt: "2026-10-21T08:00:00.000Z",
    rawEvent: { reference: "evidence:00000000-0000-4000-8000-000000000001", digestAlgorithm: "sha256" } } } });
  if (result.kind === "refused") throw Error("expected_observation");
  expect(result.observation.fact.factId).toMatch(/^[a-f0-9]{64}$/u);
  const normalized = await run(fixture({ ...payload(), occurredAt: "2026-10-21T08:00:00Z" }).input);
  expect(normalized.receiptId).toBe("order.shipped:external-a:parcel-a:2026-10-21T08:00:00Z");
  const missing = await run(fixture({ ...payload(), occurredAt: null, fulfilmentNumber: null }).input);
  expect(missing.receiptId).toBe("order.shipped:external-a:unknown-fulfilment:unknown-time");
  expect(JSON.stringify(result)).not.toContain('"shipments"');
});

it("replays donor event/status/tracking keys after a switch and retries remaining obligations (O2)", async () => {
  const f = fixture(); const verified = await f.adapter.observation.verifyAndNormalize(f.input.verification);
  if (verified.kind !== "verified") throw Error("expected_observation");
  f.inbound.set(eventKey, verified.observation);
  const statusKeys = new Set([`omnipack:webhook:${eventKey}:status`]);
  const trackingKeys = new Set([`omnipack:webhook:${eventKey}:tracking:TRACK-A`]);
  f.input.lifecycle.recordStatusEvidence = async (_ref, observation) => ({ replayed: statusKeys.has(`omnipack:webhook:${observation.eventKey}:status`) });
  f.input.lifecycle.effects.recordTrackingReference = async request => ({ replayed: trackingKeys.has(request.idempotencyKey), readBack: true });
  const result = await run(f.input);
  expect(result).toMatchObject({ receiptId: eventKey, replayed: true, trackingRefs: 0, trackingReadBacks: 1 });
  expect(f.trace).toContain("invoice"); expect(f.inbound.size).toBe(1);
});

it("replays a preseeded donor minute-precision offset key through ingress and native projection (B4)", async () => {
  const occurredAt = "2026-10-21T10:00+02:00";
  const donorKey = `order.shipped:external-a:parcel-a:${occurredAt}`;
  const f = fixture({ ...payload(), occurredAt });
  const verified = await f.adapter.observation.verifyAndNormalize(f.input.verification);
  if (verified.kind !== "verified") throw Error("expected_observation");
  expect(verified.observation.eventKey).toBe(donorKey);
  f.inbound.set(donorKey, verified.observation);
  const nativeReceipts = new Map([[donorKey, JSON.stringify(verified.observation)]]);
  const nativeWrites: unknown[][] = [];
  const native = createPostgresFulfillmentShipmentSpinePort({ async query(_statement, values = []) {
    const [key, , json, receivedAt] = values;
    expect(key).toBe(donorKey);
    expect(receivedAt).toBe(at);
    expect(Number.isFinite(Date.parse(receivedAt as string))).toBe(true);
    expect(JSON.parse(json as string).fact.occurredAt).toBe("2026-10-21T08:00:00.000Z");
    const replayed = nativeReceipts.has(key as string);
    if (replayed) expect(json).toBe(nativeReceipts.get(key as string));
    else nativeReceipts.set(key as string, json as string);
    nativeWrites.push(values);
    return { rows: [{ response: { replayed } }] };
  } }, { portKey: "donor-replay", approveTrackingUrl: f.input.approveTrackingUrl }).localPersistence;
  const memoryReceipt = f.input.localPersistence.recordObservation;
  f.input.localPersistence.recordObservation = async value => {
    expect(await memoryReceipt(value)).toEqual({ replayed: true });
    return native.recordObservation(value);
  };
  const statusKeys = new Set([`omnipack:webhook:${donorKey}:status`]);
  const trackingKeys = new Set([`omnipack:webhook:${donorKey}:tracking:TRACK-A`]);
  let newTracking = 0;
  f.input.lifecycle.recordStatusEvidence = async (_ref, value) => ({ replayed: statusKeys.has(`omnipack:webhook:${value.eventKey}:status`) });
  f.input.lifecycle.effects.recordTrackingReference = async request => {
    const replayed = trackingKeys.has(request.idempotencyKey);
    if (!replayed) { trackingKeys.add(request.idempotencyKey); newTracking++; }
    return { replayed, readBack: true };
  };
  for (let retry = 0; retry < 2; retry++) {
    expect(await run(f.input)).toMatchObject({ receiptId: donorKey, replayed: true, trackingRefs: 0, trackingReadBacks: 1,
      counts: { invalidTimestamps: 0 }, observation: { eventKey: donorKey } });
  }
  expect(f.inbound.size).toBe(1); expect(nativeReceipts.size).toBe(1);
  expect(newTracking).toBe(0); expect(trackingKeys.size).toBe(1);
  expect(nativeWrites).toHaveLength(2); expect(nativeWrites[1]).toEqual(nativeWrites[0]);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

it("returns and persists a safe superseded cause, including the native TypeScript store projection (O4)", async () => {
  for (const reason of ["fulfillment_already_terminal", "https://private.invalid/?token=placeholder"]) {
    const f = fixture();
    f.input.lifecycle.effects.markHandedOver = async () => { throw { reason }; };
    f.input.lifecycle.classifyFailure = () => "state_conflict";
    const supersededCause = reason.startsWith("https:") ? "fulfillment_state_conflict" : reason;
    expect(await run(f.input)).toMatchObject({ kind: "superseded", supersededCause });
    expect(f.processed.get(eventKey)).toEqual({ status: "processed", supersededCause });
    expect(f.trace).not.toContain("invoice");
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ response: null }] }));
    const native = createPostgresFulfillmentShipmentSpinePort({ query }, { portKey: "warehouse-a" });
    await native.localPersistence.markProcessed(eventKey, { status: "processed", supersededCause });
    expect(query.mock.calls[0]?.[1]).toEqual([eventKey, JSON.stringify({ status: "processed", supersededCause })]);
  }
});

it("requires an adopter codec for slash/space correlation and keeps typed fact IDs opaque (O5)", async () => {
  const body = { ...payload(), orderId: " external/a b ", fulfilmentNumber: null };
  expect(await run(fixture(body).input)).toMatchObject({ kind: "refused", counts: { rejectedCorrelationRefs: 1 } });
  const f = fixture(body, { observationCodecs: { approveReference: incumbentReference } });
  expect(await run(f.input)).toMatchObject({ kind: "processed", observation: {
    eventKey: "order.shipped: external/a b :unknown-fulfilment:2026-10-21T10:00:00+02:00", correlation: { externalRef: "external/a b" } } });
  const stored = [...f.inbound.values()][0]!;
  expect(stored.fact.fulfillmentReference).toMatch(/^[a-f0-9]{64}$/u);
  for (const orderId of [" ", "recipient@example.invalid", "https://private.invalid/a", "bad\u0000ref", "\nexternal-a\n", "external-a\t", "a".repeat(257)]) {
    const refused = fixture({ ...payload(), orderId, fulfilmentNumber: null });
    expect(await run(refused.input)).toMatchObject({ kind: "refused", refusal: { reason: "missing_correlation" },
      counts: { rejectedCorrelationRefs: 1 }, diagnostics: { rejectedCorrelationRefs: 1 } });
    expect(refused.inbound.size).toBe(0);
    const mixed = fixture({ ...payload(), orderId });
    expect(await run(mixed.input)).toMatchObject({ kind: "refused" }); expect(mixed.inbound.size).toBe(0);
  }
});

it("refuses credential/contact prose by default, counts it and excludes it from every durable output (B3/O5)", async () => {
  // Synthetic plants only: no actual credentials or contact data.
  for (const refused of ["Bearer placeholder-secret", "Jane Doe, +48 123 456 789"]) {
    for (const field of ["orderId", "orderNumber", "fulfilmentNumber"] as const) {
      const f = fixture({ ...payload(), [field]: refused });
      const result = await run(f.input);
      expect(result).toMatchObject({ kind: "refused", receiptId: null, counts: { rejectedCorrelationRefs: 1 }, diagnostics: { rejectedCorrelationRefs: 1 } });
      expect(f.trace).toEqual([]); expect(f.inbound.size).toBe(0);
      expect(JSON.stringify(result)).not.toContain(refused);
    }
    const body = { ...payload(), shipments: [...payload().shipments,
      { trackingNo: refused }, { trackingNo: "TRACK-B", shippingMethod: refused }] };
    const f = fixture(body); const result = await run(f.input);
    expect(result).toMatchObject({ kind: "processed", counts: { rejectedTrackingRefs: 2 }, observation: {
      eventKey, correlation: { externalRef: "external-a" }, diagnostics: { admission: { rejectedTrackingRefs: 2 } },
      trackingRefs: [{ trackingNumber: "TRACK-A" }, { trackingNumber: "TRACK-B", serviceRef: null }] } });
    // recordObservation receives the real projectObservation output, before any native JSON write.
    const stored = [...f.inbound.values()][0]!;
    for (const output of [result, stored.eventKey, stored.correlation, stored]) expect(JSON.stringify(output)).not.toContain(refused);
  }
});

it("counts rejected tracking and blank entries, retains trimmed refs and deduplicates first wins (O5)", async () => {
  const body = { ...payload(), shipments: [
    { trackingNo: " TRACK A ", carrier: "FIRST", shippingMethod: "FIRST_SERVICE" },
    { trackingNo: "TRACK A", carrier: "SECOND", shippingMethod: "SECOND_SERVICE" },
    { trackingNo: "TRACK/B" }, { trackingNo: "" }, { trackingNo: "  " }, { trackingNo: 5 },
    { trackingNo: "bad\u0000ref" }, { trackingNo: "recipient@example.invalid" },
    { trackingNo: "recipient@example.invalid" }, { trackingNo: "\nTRACK-A\n" },
  ] };
  const strict = await run(fixture(body).input);
  expect(strict).toMatchObject({ kind: "processed", trackingRefs: 0, counts: { rejectedTrackingRefs: 10 } });
  const f = fixture(body, { observationCodecs: { approveReference: incumbentReference } }); const result = await run(f.input);
  expect(result).toMatchObject({ kind: "processed", trackingRefs: 2, counts: { rejectedTrackingRefs: 7 }, observation: {
    trackingRefs: [{ trackingNumber: "TRACK A", carrierRef: "first" }, { trackingNumber: "TRACK/B" }], diagnostics: { admission: { rejectedTrackingRefs: 7 } } } });
});

it.each(["2026-10-21T10:00:00+0200", "2026-10-21T10:00+0200", "2026-10-21T10:00:00"])("admits the base webhook occurrence format %s without changing key bytes (O6)", async occurredAt => {
  const f = fixture({ ...payload(), occurredAt });
  expect(await run(f.input)).toMatchObject({ kind: "processed", receiptId: `order.shipped:external-a:parcel-a:${occurredAt}`,
    counts: { invalidTimestamps: 0 }, observation: { fact: { occurredAt: new Date(occurredAt).toISOString() } } });
  expect(f.inbound.size).toBe(1);
});

it("refuses invalid occurrence early with a counted visible diagnostic and no persistence/effects (O6)", async () => {
  for (const occurredAt of [12345, {}, "", "not-time", "2026-99-99T99:99:99Z", "2026-02-30T12:00:00Z", "2026-02-30T12:00:00+0200"]) {
    const f = fixture({ ...payload(), occurredAt });
    const result = await run(f.input);
    expect(result).toEqual({ kind: "refused", receiptId: null, refusal: { reason: "malformed", phase: "normalize", retryable: false },
      counts: { invalidTimestamps: 1, rejectedCorrelationRefs: 0, rejectedTrackingRefs: 0, rejectedTrackingUrls: 0 }, diagnostics: { invalidTimestamp: true } });
    expect(httpResult(result).status).toBe(400); expect(f.trace).toEqual([]);
  }
});

it("keeps absent/null occurrence unknown without counting a refusal (M1/O6)", async () => {
  for (const occurredAt of [undefined, null]) {
    const f = fixture({ ...payload(), occurredAt });
    expect(await run(f.input)).toMatchObject({ kind: "processed", receiptId: "order.shipped:external-a:parcel-a:unknown-time",
      counts: { invalidTimestamps: 0 }, observation: { fact: { occurredAt: null } } });
    expect(f.inbound.size).toBe(1);
  }
});

it("normalizes carrier evidence through the adapter codec and drops raw-only carrier evidence like the donor (O8)", async () => {
  const normalizeCarrier = vi.fn(() => "normalized-a");
  const f = fixture(payload(), { observationCodecs: { normalizeCarrier } });
  const record = vi.fn(async () => ({ replayed: false, readBack: false }));
  f.input.lifecycle.effects.recordTrackingReference = record;
  expect(await run(f.input)).toMatchObject({ observation: { trackingRefs: [{ carrierRef: "normalized-a" }] } });
  expect(normalizeCarrier).toHaveBeenCalledWith({ carrierRef: "CARRIER-A", serviceRef: "CARRIER-A_SERVICE" });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ carrierKind: "normalized-a" }));
  const defaultResult = await run(fixture().input);
  expect(defaultResult).toMatchObject({ observation: { trackingRefs: [{ carrierRef: "carrier-a" }] } });
  const rawOnly = fixture({ ...payload(), shipments: [{ trackingNo: "TRACK-A", carrier: "CARRIERX" }] });
  const rawRecord = vi.fn(async () => ({ replayed: false, readBack: false }));
  rawOnly.input.lifecycle.effects.recordTrackingReference = rawRecord;
  expect(await run(rawOnly.input)).toMatchObject({ observation: { trackingRefs: [{ carrierRef: null }] } });
  expect(rawRecord).toHaveBeenCalledWith(expect.objectContaining({ carrierKind: null }));
});

it("keeps strict URL defaults and lets a host retain approved query parameters with a codec (O7)", async () => {
  for (const trackingUrl of ["https://tracking.invalid/a?parcel=TRACK-A", "https://tracking.invalid/a#parcel", "http://tracking.invalid/a", "https://user:placeholder@tracking.invalid/a", "https://elsewhere.invalid/a"]) {
    const body = { ...payload(), shipments: [{ trackingNo: "TRACK-A", trackingUrl }] };
    expect(await run(fixture(body).input)).toMatchObject({ counts: { rejectedTrackingUrls: 1 }, observation: { trackingRefs: [{ publicUrl: null }] } });
    const codec = fixture(body, { observationCodecs: { trackingUrl: value => value } });
    const allowed = trackingUrl.startsWith("https://tracking.invalid/");
    expect(await run(codec.input)).toMatchObject({ counts: { rejectedTrackingUrls: allowed ? 0 : 1 }, observation: { trackingRefs: [{ publicUrl: allowed ? trackingUrl : null }] } });
  }
});

it("keeps delivered-first suppression, awaited fail-stop effect ordering and unprocessed failures", async () => {
  for (const failAt of [null, "stock", "handoff", "tracking", "invoice"] as const) {
    const f = fixture({ ...payload(), event: "order.delivered" }, { notification: { token: () => "placeholder", expectedEvent: "order.delivered" } });
    const trace: string[] = [];
    const step = async (name: string) => { await Promise.resolve(); trace.push(name); if (name === failAt) throw Error("effect_failed"); return { replayed: false, readBack: false }; };
    f.input.lifecycle.effects = { markProviderStockConsumed: () => step("stock"), markHandedOver: value => { expect(value.suppressDispatched).toBe(true); return step("handoff"); }, recordTrackingReference: () => step("tracking") };
    f.input.lifecycle.issueAccountingInvoice = async () => { await step("invoice"); };
    if (failAt) { await expect(run(f.input)).rejects.toThrow("effect_failed"); expect(f.processed.size).toBe(0); }
    else { expect(await run(f.input)).toMatchObject({ kind: "processed" }); expect(f.processed.size).toBe(1); }
    const all = ["stock", "handoff", "tracking", "invoice"];
    expect(trace).toEqual(failAt ? all.slice(0, all.indexOf(failAt) + 1) : all);
  }
});

// Capture every write callback plus the native adapter's serialized arguments;
// the executor is fake and never executes SQL or opens a database connection.
function captureDurable(f: ReturnType<typeof fixture>, overrides: Partial<OmnipackFulfillmentAdapterConfig> = {}) {
  const writes: { sink: string; value: unknown }[] = [];
  const capture = (sink: string, value: unknown) => { writes.push({ sink, value: structuredClone(value) }); };
  const native = createPostgresFulfillmentShipmentSpinePort({ async query(statement, values) {
    capture("native", { statement, values }); return { rows: [{ response: { replayed: false } }] };
  } }, { portKey: "privacy-test", approveTrackingUrl: f.input.approveTrackingUrl, observationCodecs: overrides.observationCodecs }).localPersistence;
  const persistence = f.input.localPersistence;
  f.input.localPersistence = {
    async recordObservation(value) { capture("receipt", value); await native.recordObservation(value); return persistence.recordObservation(value); },
    async markProcessed(key, value) { capture("processed", { key, value }); await native.markProcessed(key, value); return persistence.markProcessed(key, value); },
  };
  f.input.lifecycle.acknowledgeDispatchAcceptance = async (ref, value) => { capture("ack", { ref, value }); };
  f.input.lifecycle.recordStatusEvidence = async (ref, value) => { capture("status", { ref, value }); return native.recordStatusEvidence(ref, value); };
  for (const effect of ["markProviderStockConsumed", "markHandedOver", "recordTrackingReference"] as const) {
    f.input.lifecycle.effects[effect] = async value => { capture(effect, value); return { replayed: false, readBack: false }; };
  }
  f.input.lifecycle.issueAccountingInvoice = async ref => { capture("invoice", ref); };
  return writes;
}

it("suppresses carriers derived from refused services in durable writes and effects, including an explicit deny allowlist (B3)", async () => {
  for (const [shippingMethod, observationCodecs] of [
    ["synthetic-secret_/private", undefined],
    ["DENIED_SERVICE", { approveReference: (value: string) => ["external-a", "parcel-a", "TRACK-A"].includes(value) }],
  ] as const) {
    const overrides = { observationCodecs };
    const f = fixture({ ...payload(), shipments: [{ trackingNo: "TRACK-A", shippingMethod }] }, overrides);
    const writes = captureDurable(f, overrides);
    const result = await run(f.input);
    expect(result).toMatchObject({ kind: "processed", counts: { rejectedTrackingRefs: 1 }, observation: {
      diagnostics: { redactedFieldCount: 1 }, trackingRefs: [{ trackingNumber: "TRACK-A", carrierRef: null, serviceRef: null }] } });
    for (const value of [result, writes]) {
      const text = JSON.stringify(value).toLowerCase();
      expect(text).not.toContain(shippingMethod.toLowerCase());
      expect(text).not.toContain(shippingMethod.split("_")[0]!.toLowerCase());
    }
    expect(writes.map(write => write.sink)).toContain("recordTrackingReference");
    // Bypass adapter admission: the real durable sink must independently reject
    // an opaque-looking carrier paired with a refused original service.
    const candidate = [...f.inbound.values()][0]!;
    candidate.trackingRefs = [{ trackingNumber: "TRACK-A", carrierRef: shippingMethod.split("_")[0]!.toLowerCase(), serviceRef: shippingMethod, publicUrl: null }];
    candidate.diagnostics = undefined;
    const query = vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [{ response: { replayed: false } }] }));
    await createPostgresFulfillmentShipmentSpinePort({ query }, { portKey: "privacy-test", observationCodecs }).localPersistence.recordObservation(candidate);
    const stored = JSON.parse(query.mock.calls[0]![1]![2] as string);
    expect(stored).toMatchObject({ diagnostics: { redactedFieldCount: 2 }, trackingRefs: [{ carrierRef: null, serviceRef: null }] });
    expect(JSON.stringify(stored).toLowerCase()).not.toContain(shippingMethod.split("_")[0]!.toLowerCase());
  }
});

it("counts malformed and rejected service/URL inputs before extraction and deduplication while retaining first-wins data (M2)", async () => {
  for (const metadata of [
    { shippingMethod: {}, trackingUrl: 123 },
    { shippingMethod: "Jane Doe +12025550123", trackingUrl: "https://unapproved.invalid/a" },
    { service: "", trackingURL: "", trackingLink: false, publicTrackingUrl: {} },
  ]) {
    const body = { ...payload(), shipments: [{ trackingNo: "TRACK-A", ...metadata }] };
    const rejectedRefs = 1;
    const rejectedUrls = "trackingUrl" in metadata ? 1 : 3;
    const malformed = await run(fixture(body).input);
    expect(malformed).toMatchObject({ kind: "processed", counts: { rejectedTrackingRefs: rejectedRefs, rejectedTrackingUrls: rejectedUrls } });
    const f = fixture({ ...payload(), shipments: [...payload().shipments, ...body.shipments] });
    const result = await run(f.input);
    expect(result).toMatchObject({ kind: "processed", trackingRefs: 1, counts: { rejectedTrackingRefs: rejectedRefs, rejectedTrackingUrls: rejectedUrls }, observation: {
      trackingRefs: [{ trackingNumber: "TRACK-A", carrierRef: "carrier-a", serviceRef: "CARRIER-A_SERVICE", publicUrl: "https://tracking.invalid/a" }] } });
    expect([...f.inbound.values()][0]!.trackingRefs).toHaveLength(1);
    const rejectedNumber = await run(fixture({ ...payload(), shipments: [{ trackingNo: "", ...metadata }] }).input);
    expect(rejectedNumber).toMatchObject({ counts: { rejectedTrackingRefs: rejectedRefs + 1, rejectedTrackingUrls: rejectedUrls } });
  }
});

it("sweeps every webhook string field through observation ingress, projections and all durable writes", async () => {
  const plants = ["Jane Doe +12025550123", "jane.doe@example.invalid", "12 Example Street", '{"contact":{"email":"jane@example.invalid","phone":"+12025550123"}}', "Bearer synthetic.secret/contact+token="];
  const fields = ["event", "orderId", "providerOrderId", "orderNumber", "fulfilmentNumber", "occurredAt",
    "shipments.trackingNo", "shipments.trackingNumber", "shipments.shippingMethod", "shipments.service",
    "shipments.trackingUrl", "shipments.trackingURL", "shipments.trackingLink", "shipments.publicTrackingUrl",
    "shipments.carrier", "shipments.carrierCode", "authorization", "x-omnipack-webhook-token"];
  const reached = new Set<string>();
  for (const field of fields) for (const plant of plants) {
    const body: Record<string, unknown> = { ...payload(), shipments: [{ trackingNo: "TRACK-A" }] };
    if (field.startsWith("shipments.")) {
      const shipment = (body.shipments as Record<string, unknown>[])[0]!;
      if (field === "shipments.trackingNumber") delete shipment.trackingNo;
      shipment[field.slice("shipments.".length)] = plant;
    } else if (!["authorization", "x-omnipack-webhook-token"].includes(field)) {
      if (field === "providerOrderId") delete body.orderId;
      body[field] = plant;
    }
    const f = fixture(body);
    if (field === "authorization") f.input.verification.headers = { authorization: plant };
    if (field === "x-omnipack-webhook-token") f.input.verification.headers = { [field]: plant };
    const writes = captureDurable(f);
    const result = await run(f.input);
    const refuses = ["event", "orderId", "providerOrderId", "orderNumber", "fulfilmentNumber", "occurredAt", "authorization", "x-omnipack-webhook-token"].includes(field);
    expect(result.kind, field).toBe(refuses ? "refused" : "processed");
    if (refuses) expect(writes, field).toEqual([]);
    else for (const write of writes) reached.add(write.sink);
    for (const output of [result, writes, [...f.inbound.values()], [...f.processed.values()]]) {
      const text = JSON.stringify(output);
      for (const forbidden of plants) {
        expect(text, field).not.toContain(forbidden);
        expect(text, field).not.toContain(JSON.stringify(forbidden).slice(1, -1));
        expect(text.toLowerCase(), field).not.toContain(forbidden.toLowerCase());
      }
    }
  }
  expect([...reached]).toEqual(expect.arrayContaining(["receipt", "native", "processed", "ack", "status", "markProviderStockConsumed", "markHandedOver", "recordTrackingReference", "invoice"]));
});

it("forwards one adopter policy through repeated ingress and native projections without losing approved URL queries or reference bytes", async () => {
  const overrides = { observationCodecs: { approveReference: incumbentReference, trackingUrl: (url: string) => url } };
  const f = fixture({ ...payload(), orderId: " external/a b ", shipments: [{ trackingNo: "TRACK A", trackingUrl: "https://tracking.invalid/a?parcel=TRACK-A" }] }, overrides);
  const writes = captureDurable(f, overrides);
  expect(await run(f.input)).toMatchObject({ kind: "processed", counts: { rejectedTrackingUrls: 0 }, observation: {
    eventKey: "order.shipped: external/a b :parcel-a:2026-10-21T10:00:00+02:00", correlation: { externalRef: "external/a b" },
    trackingRefs: [{ trackingNumber: "TRACK A", publicUrl: "https://tracking.invalid/a?parcel=TRACK-A" }] } });
  const receipt = writes.find(write => write.sink === "receipt")!.value;
  const native = writes.find(write => write.sink === "native")!.value as { values: unknown[] };
  expect(JSON.parse(native.values[2] as string)).toEqual(receipt);
  const verification = await f.adapter.observation.verifyAndNormalize(f.input.verification);
  if (verification.kind !== "verified") throw Error("expected_observation");
  writes.length = 0;
  const reconciled = await reconcileFulfillmentObservations({ batchSize: 1,
    readPage: async () => [{ kind: "found", externalRef: "external-a", createdAt: at, updatedAt: at, observation: verification.observation }],
    localPersistence: { readLocalFulfillmentStatus: async () => "in_transit", latestStatusOccurredAt: async () => null, readHandedOverAt: async () => null },
    lifecycle: { ...f.input.lifecycle,
      recordQuarantine: async () => { throw Error("unexpected_quarantine"); },
      recordProviderException: async () => { throw Error("unexpected_exception"); },
      readDeliveryCarrier: async () => null,
      trackingCodecs: { ...overrides.observationCodecs, approveTrackingUrl: f.input.approveTrackingUrl, normalizeCarrier: value => value.carrierRef, publicUrl: () => null },
      invoiceFailure: () => { throw Error("unexpected_invoice_failure"); }, classifyStateConflict: () => null,
    } });
  expect(reconciled).toMatchObject({ ok: true, trackingRefs: 1 });
  expect(writes.find(write => write.sink === "recordTrackingReference")!.value).toMatchObject({ trackingNumber: "TRACK A", trackingUrl: "https://tracking.invalid/a?parcel=TRACK-A" });
});
