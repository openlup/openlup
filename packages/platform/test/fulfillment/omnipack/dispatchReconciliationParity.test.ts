import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import type { DispatchRecord, FulfillmentDispatchRequest, FulfillmentDispatchResult } from "../../../src/fulfillment/contracts/index.js";
import { createFulfillmentServices, createPostgresFulfillmentDispatchStore, createPostgresFulfillmentShipmentSpinePort, reconcileFulfillmentObservations, runFulfillmentDispatchWorker, runFulfillmentReconciliationPage } from "../../../src/fulfillment/index.js";
import { createOmnipackFulfillmentAdapter } from "../../../src/fulfillment/omnipack/index.js";
import { dispatchResult, durableStrings, localFailureReason } from "../../../src/fulfillment/dispatchProjection.js";
import { projectObservation } from "../../../src/fulfillment/observationProjection.js";
import { ingressFixture, memoryStore, observation, profile, request } from "../fixtures.js";

// Synthetic inputs preserved from the M08 b3 probe dispatch/reconciliation scenarios.
const now = "2026-10-22T22:30:00.000Z";
const row = { orderId: "external-a", fulfilmentNumber: "parcel-a", orderNumber: "ORDER-A", status: "shipping", subStatus: "ready", updatedAt: now, createdAt: now,
  shipments: [{ trackingNo: "TRACK-A", carrier: "CARRIER-A", shippingMethod: "CARRIER-A_SERVICE", trackingUrl: "https://tracking.invalid/TRACK-A" }] };
function candidate(): FulfillmentDispatchRequest {
  const r = request();
  return { ...r, orderNumber: "ORDER-A", recipient: { ...r.recipient, name: "Example", email: "example@example.invalid", phone: "+12025550123", country: "US" },
    lines: [{ skuRef: "SKU-A", quantity: 1, title: null, productRef: null, packRef: null }],
    selection: { providerRef: "omnipack", carrierRef: "CARRIER-A", serviceRef: "SERVICE-A", deliveryKind: "courier", pickupPoint: null } };
}
function adapter(reply: (url: URL, init: RequestInit) => Response | Promise<Response> = () => Response.json({ orderId: "external-a" }),
  metadata = { lotNumber: "LOT-A", expirationDate: "2027-01-01" }) {
  const http = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => reply(new URL(String(url)), init!));
  const credentials = vi.fn(() => ({ username: "fake", password: "fake" }));
  return { http, credentials, adapter: createOmnipackFulfillmentAdapter({ http: { baseUrl: "https://warehouse.invalid", fetchImpl: http, credentials, timeoutMs: 5, safeReadRetries: 1, productPath: "/products" },
    selected: true, readiness: { ready: true }, resolveProduct: async () => metadata,
    notification: { token: () => "fake", expectedEvent: "order.shipped" }, clock: () => now,
    mintEvidenceReference: () => "evidence:00000000-0000-4000-8000-000000000001", mintSyncRunId: () => "sync-a", approveTrackingUrl: () => true }) };
}
const keys = { request: () => "host-dispatch:fulfillment-a", mappedAttempt: (key: string, index: number) => `${key}:attempt:${index}`,
  acceptance: () => ({ providerAttemptKey: "host:provider-accepted", labelKey: "host:label-ack" }) };
function dispatchFixture(a = adapter()) {
  const base = memoryStore(), writes: FulfillmentDispatchResult[] = [], trace: string[] = [];
  const store = { ...base, readCandidate: async () => candidate(),
    async claim(input: Parameters<typeof base.claim>[0]) { trace.push("claim"); return base.claim(input); },
    async recordProviderAttempt(...args: Parameters<typeof base.recordProviderAttempt>) {
      trace.push("attempt");
      // Native attempt recording requires the exact claimed evidence, including metadata.
      expect((await base.read(keys.request()))!.evidence).toEqual(args[2]);
      return base.recordProviderAttempt(...args);
    },
    async finalize(input: Parameters<typeof base.finalize>[0]) { writes.push(structuredClone(input.result)); return base.finalize(input); },
  };
  return { ...a, base, store, writes, trace,
    run: (mode: DispatchRecord["mode"] = "stage") => runFulfillmentDispatchWorker({ store, provider: a.adapter.dispatch, keys, listCandidates: async () => [candidate()], config: { mode, batchLimit: 10 }, now: () => new Date(now) }) };
}
// Model the native receipt's whole-JSON fence, rather than just its externalRef.
function nativeDispatchFixture(capture: (sink: string, value: unknown) => void, ackError?: Error) {
  const memory = memoryStore(), receipts: unknown[] = [];
  let acceptance: Extract<FulfillmentDispatchResult, { kind: "accepted" }> | undefined, failAck = Boolean(ackError);
  const native = createPostgresFulfillmentDispatchStore({ async query(statement, values = []) {
    let result: unknown;
    if (statement.startsWith("UPDATE")) return { rows: [] };
    if (statement.startsWith("SELECT public.fulfillment_dispatch_read")) {
      const record = await memory.read(String(values[0]));
      result = record && { ...record, ...(acceptance ? { acceptance } : {}) };
    } else {
      capture("native-dispatch", { statement, values });
      if (statement.includes("fulfillment_dispatch_claim(")) result = await memory.claim({ requestKey: String(values[0]), fulfillmentRef: String(values[1]),
        orderRef: String(values[2]), parcelRef: values[3] as string | null, mode: values[4] as DispatchRecord["mode"], evidence: JSON.parse(values[5] as string) });
      else if (statement.includes("fulfillment_record_provider_attempt(")) result = await memory.recordProviderAttempt(String(values[0]), String(values[1]), JSON.parse(values[2] as string), values[3] as DispatchRecord["mode"], "recorded");
      else if (statement.includes("fulfillment_dispatch_begin(")) result = await memory.begin({ dispatchRef: String(values[0]), commandFingerprint: String(values[1]) });
      else if (statement.includes("fulfillment_dispatch_finish(")) {
        const receipt = JSON.parse(values[1] as string) as FulfillmentDispatchResult;
        if (values[2]) {
          if (failAck) { failAck = false; throw ackError; }
          const record = await memory.read(keys.request()), replayed = record?.status === "created";
          if (replayed && !isDeepStrictEqual(acceptance, receipt)) throw Error("fulfillment_dispatch_ack_key_conflict");
          if (receipt.kind !== "accepted") throw Error("expected_acceptance");
          acceptance = receipt; receipts.push(structuredClone(receipt));
          result = { ...await memory.acknowledge({ dispatchRef: String(values[0]), acceptance }), replayed };
        } else {
          if (receipt.kind === "accepted") acceptance = receipt;
          capture(receipt.kind === "accepted" ? "accepted-ack-recovery" : "dispatch-finalize", receipt);
          result = await memory.finalize({ dispatchRef: String(values[0]), result: receipt });
        }
      } else throw Error("unexpected_native_call");
    }
    return { rows: [{ response: result }] };
  } }, { prepare: memory.prepare, readCandidate: async () => candidate() });
  return { native, memory, receipts };
}
function assertNativeObservation(values: unknown[]) {
  const observation = JSON.parse(values[2] as string);
  for (const value of [values[3], observation.firstReceivedAt, observation.fact.receivedAt, observation.fact.occurredAt]) {
    if (value === null) continue;
    expect(value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u);
    expect(Number.isFinite(Date.parse(value as string))).toBe(true);
  }
}
it.each(["sweep", "begin", "attempt"] as const)("dispatch-%s retains stage and safe SQLSTATE before POST", async stage => {
  const f = dispatchFixture();
  const fail = async () => { throw Error(`${stage}_down:42P01`); };
  if (stage === "sweep") f.store.markStaleSubmissionsUncertain = fail;
  else if (stage === "begin") f.store.begin = fail;
  else f.store.recordProviderAttempt = fail;
  expect(await f.run()).toMatchObject({ ok: false, failures: 1, providerCalls: 0, reason: expect.stringContaining(`${stage}_down:42P01`) });
  expect(f.http).not.toHaveBeenCalled();
});
it("dispatch-ok persists the redacted mapped items, revisions, selection and mode", async () => {
  const f = dispatchFixture();
  expect(await f.run()).toMatchObject({ ok: true, updated: 1, providerCalls: 1 });
  const attempts = await f.base.readMappedAttempts();
  expect(attempts[0]!.preparedEvidence).toMatchObject({ contactRevision: candidate().contactRevision,
    providerRef: "omnipack", carrierRef: "CARRIER-A", serviceRef: "SERVICE-A",
    transcript: { itemCount: 1, items: [{ skuRef: "SKU-A", quantity: 1, lotRef: "LOT-A", expirationDate: "2027-01-01" }], deliveryKind: "courier", pickupPointRef: null },
    mapping: { source: "dispatch_worker", mode: "stage", shadowMode: false } });
  expect(JSON.stringify(attempts)).not.toMatch(/example@example|1202555|Synthetic|recipient|password|signedUrl/);
  expect(f.http).toHaveBeenCalledTimes(1);
});
it.each(["stage", "shadow"] as const)("%s transcript metadata is validated before persistence without failing dispatch", async mode => {
  const contactJson = JSON.stringify({ email: candidate().recipient.email, phone: candidate().recipient.phone });
  const cases = [
    { lotNumber: contactJson, expirationDate: "2027-01-01", lotRef: null, date: "2027-01-01", count: 1 },
    { lotNumber: "LOT-A", expirationDate: candidate().recipient.phone!, lotRef: "LOT-A", date: null, count: 1 },
    { lotNumber: "LOT-A", expirationDate: "2027-02-30", lotRef: "LOT-A", date: null, count: 1 },
    { lotNumber: "LOT-A_1:2.3", expirationDate: "2028-02-29", lotRef: "LOT-A_1:2.3", date: "2028-02-29", count: 0 },
  ];
  for (const spec of cases) {
    const f = dispatchFixture(adapter(undefined, spec)), req = candidate();
    req.lines = [{ ...req.lines[0]!, lotRef: spec.lotNumber, expirationDate: spec.expirationDate }];
    f.store.readCandidate = async () => req;
    expect(await runFulfillmentDispatchWorker({ store: f.store, provider: mode === "shadow" ? null : f.adapter.dispatch,
      keys, listCandidates: async () => [req], config: { mode, batchLimit: 1 } })).toMatchObject({ ok: true, failures: 0, providerCalls: mode === "shadow" ? 0 : 1 });
    const evidence = (await f.base.readMappedAttempts())[0]!.preparedEvidence;
    expect(evidence.transcript!.items[0]).toEqual({ skuRef: "SKU-A", quantity: 1, lotRef: spec.lotRef, expirationDate: spec.date });
    expect(evidence.transcript!.redactedFieldCount ?? 0).toBe(spec.count);
    const query = vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [{ response: {} }] }));
    const native = createPostgresFulfillmentDispatchStore({ query }, { prepare: f.store.prepare, readCandidate: f.store.readCandidate });
    // Exercise repeated sanitization at every native evidence write boundary.
    await native.claim({ requestKey: keys.request(), fulfillmentRef: req.fulfillmentRef, orderRef: req.orderRef, parcelRef: req.parcelRef, mode, evidence });
    await native.recordProviderAttempt(keys.mappedAttempt(keys.request(), 0), req.fulfillmentRef, evidence, mode, "recorded");
    await native.acknowledge({ dispatchRef: "dispatch-a", acceptance: { kind: "accepted", externalRef: "external-a", evidence, ...keys.acceptance() } });
    const calls = query.mock.calls;
    expect(JSON.parse(calls[0]![1]![5] as string)).toEqual(evidence);
    expect(JSON.parse(calls[1]![1]![2] as string)).toEqual(evidence);
    expect(JSON.parse(calls[2]![1]![1] as string).evidence).toEqual(evidence);
    expect(JSON.stringify([await f.base.read(keys.request()), calls])).not.toMatch(/example@example|1202555|email/);
    if (mode === "shadow") { expect(f.credentials).not.toHaveBeenCalled(); expect(f.http).not.toHaveBeenCalled(); }
  }
});
it.each(["lost", "committed", "readback_failed", "finalize_failed"] as const)("ACK %s preserves proof and never repeats POST", async scenario => {
  const f = dispatchFixture();
  let ack = 0, finalized = false;
  const acknowledge = f.store.acknowledge;
  f.store.acknowledge = async input => {
    if (ack++ === 0) {
      if (scenario === "committed") await acknowledge(input);
      throw Error("ack_write_down:XX001");
    }
    return acknowledge(input);
  };
  const read = f.store.read;
  f.store.read = async key => {
    if (scenario === "readback_failed" && ack === 1 && !finalized) throw Error("readback_down:42P01");
    return read(key);
  };
  const finalize = f.store.finalize;
  f.store.finalize = async input => { finalized = true; if (scenario === "finalize_failed") throw Error("finalize_down:42P01"); return finalize(input); };
  const first = await f.run();
  expect(first).toMatchObject({ ok: scenario === "committed", providerCalls: 1 });
  if (scenario !== "committed" && scenario !== "finalize_failed") expect(f.writes[0]).toMatchObject({ kind: "accepted", externalRef: "external-a",
    error: { code: "dispatch_acceptance_write_failed", cause: "ack:ack_write_down:XX001", mayHaveSucceeded: true, retryable: false, status: null } });
  const next = await f.run();
  expect(next.providerCalls).toBe(0); expect(f.http).toHaveBeenCalledTimes(1);
  if (scenario === "finalize_failed") expect(next).toMatchObject({ ok: false, reason: "dispatch_not_safe_to_submit:submitting" });
  else expect(next.ok).toBe(true);
});
it.each([
  { name: "400", status: 400, code: "BAD_SKU", ambiguous: false },
  { name: "503", status: 503, code: "FAKE_PROVIDER_DOWN", ambiguous: true },
  { name: "timeout", status: null, code: "network_error", ambiguous: true },
  { name: "redirect", status: null, code: "redirect_refused", ambiguous: true },
  { name: "broken-400-body", status: 400, code: "http_400", ambiguous: false },
])("dispatch-$name keeps typed error detail and fences repeated invocations", async spec => {
  const f = dispatchFixture(adapter(async (_url, init) => {
    if (spec.name === "timeout") return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("scripted timeout", "AbortError")), { once: true }));
    if (spec.name === "redirect") { expect(init.redirect).toBe("error"); throw TypeError("scripted redirect refused"); }
    if (spec.name === "broken-400-body") return { ok: false, status: 400, text: async () => { throw Error("private body"); } } as unknown as Response;
    return Response.json({ code: spec.code, message: "example@example.invalid", signedUrl: "https://tracking.invalid/?token=fake" }, { status: spec.status! });
  }));
  expect(await f.run()).toMatchObject({ ok: false, providerCalls: 1, reason: spec.code });
  expect(f.writes[0]).toEqual({ kind: spec.ambiguous ? "unknown" : "not_dispatched", effectMayHaveSucceeded: spec.ambiguous,
    refusal: { reason: "io_failure", phase: "dispatch", retryable: false }, error: { code: spec.code, status: spec.status, retryable: false, mayHaveSucceeded: spec.ambiguous, submissionAttempted: true,
      ...(spec.status !== null ? { responseBodyRead: spec.name !== "broken-400-body" } : {}) } });
  expect(await f.run()).toMatchObject({ providerCalls: 0 }); expect(f.http).toHaveBeenCalledTimes(1);
});
it("shadow-null builds locally and readiness does not require a provider", async () => {
  const f = dispatchFixture(), prepare = vi.spyOn(f.adapter.dispatch, "prepare");
  const r = candidate(); r.selection.providerRef = "warehouse-a";
  f.store.readCandidate = async () => r;
  const services = createFulfillmentServices({ enabled: true, selection: r.selection, capability: profile(), store: f.store, provider: null,
    readiness: async () => ({ ready: true }), listCandidates: async () => [r], keys, config: { mode: "shadow", batchLimit: 10 } });
  expect(await services.readiness()).toEqual({ ready: true });
  expect(await services.runDispatch()).toMatchObject({ ok: true, providerCalls: 0, updated: 1 });
  expect((await f.base.readMappedAttempts())[0]!.preparedEvidence.mapping).toEqual({ source: "dispatch_worker", mode: "shadow", shadowMode: true });
  expect(prepare).not.toHaveBeenCalled(); expect(f.credentials).not.toHaveBeenCalled(); expect(f.http).not.toHaveBeenCalled();
  expect(await f.run("shadow")).toMatchObject({ ok: true, providerCalls: 0 }); expect(prepare).not.toHaveBeenCalled();
});
it("native readback retains acceptance JSON for exact ACK replay after recovery", async () => {
  const evidence = { commandFingerprint: "a".repeat(64), contactRevision: candidate().contactRevision, providerRef: "omnipack", carrierRef: "CARRIER-A", serviceRef: "SERVICE-A" };
  const acceptance = dispatchResult({ kind: "accepted", externalRef: "external-a", evidence, ...keys.acceptance(),
    recovery: { source: "persisted_acceptance", proof: "persisted_external_ref", noProviderPost: true },
    error: { code: "dispatch_acceptance_write_failed", cause: "ack:ack_write_down:XX001", status: null, retryable: false, mayHaveSucceeded: true } });
  const record = { dispatchRef: "dispatch-a", requestKey: keys.request(), fulfillmentRef: "fulfillment-a", orderRef: "order-a", parcelRef: null,
    externalRef: "external-a", mode: "stage", status: "created", evidence, replayed: false, acceptance };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT public.fulfillment_dispatch_read")) { expect(sql).toContain("ref.acceptance"); return { rows: [{ response: record }] }; }
    expect(JSON.parse(values![1] as string)).toEqual(acceptance);
    return { rows: [{ response: { acknowledged: true, replayed: true, record } }] };
  });
  const store = createPostgresFulfillmentDispatchStore({ query }, { prepare: async () => ({ disposition: "ready", contactRevision: 1 }), readCandidate: async () => candidate() });
  expect(await runFulfillmentDispatchWorker({ store, provider: null, keys, listCandidates: async () => [candidate()], config: { mode: "shadow", batchLimit: 10 } })).toMatchObject({ ok: true, providerCalls: 0, replayed: 1 });
});

function reconciliationFixture(rows = [row]) {
  const a = adapter(() => Response.json({ _embedded: { fulfilments: rows }, page: { number: 0, size: 2, totalPages: 1, totalElements: rows.length } }));
  const f = ingressFixture();
  const input: Parameters<typeof reconcileFulfillmentObservations>[0] = { batchSize: 2,
    readPage: async params => { const page = await a.adapter.reconciliation.readPage(params); if (page.kind !== "page") throw Error("expected_page"); return page.rows; },
    localPersistence: {
      async readLocalFulfillmentStatus() { f.trace.push("local-status"); return "label_created"; },
      async latestStatusOccurredAt() { f.trace.push("latest"); return null; },
      async readHandedOverAt() { f.trace.push("handed"); return null; },
    },
    lifecycle: { ...f.input.lifecycle,
      async recordQuarantine(_evidence, reason) { f.trace.push(`quarantine:${reason}`); return { replayed: false }; },
      async recordProviderException() { f.trace.push("exception"); return { replayed: false }; },
      async readDeliveryCarrier() { throw Error("unused_read"); }, trackingCodecs: { approveTrackingUrl: url => url.startsWith("https://tracking.invalid/"), normalizeCarrier: value => value.carrierRef, publicUrl: () => null },
      invoiceFailure: error => { const e = error as { causeCode: string; causeMessage: string }; return { permanent: e.causeCode === "22023", identifier: e.causeMessage, sqlstate: e.causeCode, benign: false }; }, classifyStateConflict: () => null,
    } };
  return { ...a, ...f, input, run: () => reconcileFulfillmentObservations(input) };
}
it.each(["ack", "latest", "handed"] as const)("recon-%s-error preserves the donor read order and safe cause", async stage => {
  const f = reconciliationFixture();
  const fail = async () => { f.trace.push(stage); throw Error(`${stage}_read_failed:42P01`); };
  if (stage === "ack") f.input.lifecycle.acknowledgeDispatchAcceptance = fail;
  else if (stage === "latest") f.input.localPersistence.latestStatusOccurredAt = fail;
  else f.input.localPersistence.readHandedOverAt = fail;
  const result = await f.run();
  expect(result.ok).toBe(stage === "handed");
  if (stage !== "handed") expect(result.reason).toContain(`${stage}_read_failed:42P01`);
  expect(f.trace.slice(0,3)).toEqual(["find", "local-status", "ack"]);
  if (stage !== "ack") expect(f.trace.indexOf("ack")).toBeLessThan(f.trace.indexOf("latest"));
  expect(f.trace).not.toContain("handed");
});
it.each(["22023", "23514"])("invoice %s retains accounting identity and permanent/transient semantics", async sqlstate => {
  const f = reconciliationFixture();
  f.input.lifecycle.issueAccountingInvoice = async () => { throw Object.assign(Error("invoice_rpc_failed"), { causeCode: sqlstate, causeMessage: "accounting_invoice_payment_not_succeeded" }); };
  expect(await f.run()).toMatchObject({ ok: sqlstate === "22023", invoiceIssueRefused: sqlstate === "22023" ? 1 : 0, invoiceIssueFailures: sqlstate === "23514" ? 1 : 0,
    reason: expect.stringContaining(`accounting_invoice_payment_not_succeeded:${sqlstate}`) });
});
it.each([false, true])("unknown provider status ACK/quarantine; offTrack=%s stays benign", async offTrack => {
  const f = reconciliationFixture([{ ...row, status: "NEW_UNKNOWN" }]);
  f.input.localPersistence.readLocalFulfillmentStatus = async () => offTrack ? "cancelled" : "label_created";
  const seen: unknown[] = [];
  f.input.lifecycle.acknowledgeDispatchAcceptance = async (_ref, evidence) => { f.trace.push("ack"); seen.push(evidence); };
  f.input.lifecycle.recordQuarantine = async (evidence, reason) => { f.trace.push(`quarantine:${reason}`); seen.push(evidence); return { replayed: false }; };
  expect(await f.run()).toMatchObject({ ok: true, quarantined: offTrack ? 0 : 1, offTrackSkips: offTrack ? 1 : 0 });
  expect(f.trace).toEqual(offTrack ? ["find"] : ["find", "ack", "quarantine:unknown_status"]);
  if (!offTrack) for (const evidence of seen) expect(evidence).toMatchObject({ providerStatus: { primary: "NEW_UNKNOWN", subStatus: "ready" } });
});
it("duplicate aliases and substatuses retain separate status evidence and stable duplicate receipts", async () => {
  const f = reconciliationFixture([{ ...row, status: "ready_for_packing" }, { ...row, status: "awaiting_courier" }, { ...row, status: "awaiting_courier", subStatus: "other" }, { ...row, status: "ready_for_packing" }]);
  const evidence: unknown[] = [], record = f.input.lifecycle.recordStatusEvidence;
  f.input.lifecycle.recordStatusEvidence = async (ref, value) => { evidence.push(value); return record(ref, value); };
  expect(await f.run()).toMatchObject({ ok: true, checked: 4, updated: 3 });
  expect(evidence[0]).toMatchObject({ providerStatus: { primary: "ready_for_packing", subStatus: "ready" } });
  expect(new Set(evidence.map(value => (value as { eventKey: string }).eventKey)).size).toBe(3);
  expect(await f.run()).toMatchObject({ updated: 0 });
});
it("failed full pages advance; short and empty pages reset, and checkpoint resumes the next page", async () => {
  const f = reconciliationFixture(); let checkpoint: unknown = null;
  const requested: number[] = [];
  const pages = [[row, { ...row, orderId: "external-b", fulfilmentNumber: "parcel-b" }], [{ ...row, orderId: "external-c", fulfilmentNumber: "parcel-c" }], []];
  const a = adapter(url => { const page = Number(url.searchParams.get("page")); requested.push(page); return Response.json({ _embedded: { fulfilments: pages[page] } }); });
  f.input.lifecycle.acknowledgeDispatchAcceptance = async () => { throw Error("ack_read_failed:42P01"); };
  for (const [page, checked, nextPage] of [[0,2,1], [1,1,0], [0,2,1]] as const) {
    const run = await runFulfillmentReconciliationPage({ ...f.input, provider: a.adapter.reconciliation, pageSize: 2, checkpoint });
    expect(run).toMatchObject({ status: 502, ledgerStatus: "failed", result: { ok: false, checked }, metadata: { reconciliationPagination: { page, pageSize: 2, nextPage } } });
    checkpoint = run.metadata;
  }
  expect(requested).toEqual([0,1,0]);
  f.input.lifecycle.classifyStateConflict = () => { throw Error("classifier_failed:42P01"); };
  const aborted = await runFulfillmentReconciliationPage({ ...f.input, provider: a.adapter.reconciliation, pageSize: 2, checkpoint: null });
  expect(aborted).toMatchObject({ status: 502, result: { checked: 0, providerCalls: 1 }, metadata: { reconciliationPagination: { nextPage: 0 } } });
  const end = await runFulfillmentReconciliationPage({ ...f.input, provider: a.adapter.reconciliation, pageSize: 2, checkpoint: { reconciliationPagination: { version: 1, page: 1, nextPage: 2, pageSize: 2 } } });
  expect(end).toMatchObject({ status: 200, result: { checked: 0 }, metadata: { reconciliationPagination: { nextPage: 0 } } });
});
it.each(["ERR_PAGE_MUST_BE_LESS_THAN_TOTAL_PAGES", "OTHER_ERROR"])("page 400 %s has the exact exhausted-page classification", async code => {
  const f = reconciliationFixture(), a = adapter(() => Response.json({ code }, { status: 400 }));
  const result = await runFulfillmentReconciliationPage({ ...f.input, provider: a.adapter.reconciliation, pageSize: 2, checkpoint: { reconciliationPagination: { version: 1, page: 1, nextPage: 2, pageSize: 2 } } });
  expect(result).toMatchObject({ status: code === "OTHER_ERROR" ? 502 : 200, result: { ok: code !== "OTHER_ERROR", checked: 0, providerCalls: 1, reason: code === "OTHER_ERROR" ? code : "page_exhausted" }, metadata: { reconciliationPagination: { page: 2, nextPage: 0 } } });
  expect(f.trace).toEqual([]); expect(a.http).toHaveBeenCalledTimes(2);
});
it("invalid or resized checkpoints restart at zero; exact lookup still refuses partial and duplicate pages", async () => {
  const f = reconciliationFixture();
  for (const saved of [{ version: 1, pageSize: 3, page: 4, nextPage: 5 }, { version: 1, pageSize: 2, page: 1, nextPage: 9 }, { version: 1, pageSize: 2, page: -1, nextPage: 0 }]) {
    const provider = { readPage: vi.fn(async () => ({ kind: "page" as const, rows: [] })) };
    await runFulfillmentReconciliationPage({ ...f.input, provider, pageSize: 2, checkpoint: { reconciliationPagination: saved } });
    expect(provider.readPage).toHaveBeenCalledWith({ page: 0, size: 2 });
  }
  const exact = await f.adapter.readback.read({ providerRef: "omnipack", requestKey: "request-a", fulfillmentRef: "fulfillment-a", externalRef: "parcel-a", mode: "parcel" });
  expect(exact).toMatchObject({ kind: "found", externalRef: "parcel-a" });
  for (const [rows, extra] of [[[row], { partial: true }], [[row,row], {}], [[row], { page: { number: 0, totalPages: 2, totalElements: 2, size: 1 } }]] as const) {
    const a = adapter(() => Response.json({ _embedded: { fulfilments: rows }, page: { number: 0, totalPages: 1, totalElements: rows.length, size: 100 }, ...extra }));
    expect(await a.adapter.readback.read({ providerRef: "omnipack", requestKey: "request-a", fulfillmentRef: "fulfillment-a", externalRef: "external-a", mode: "command" })).toMatchObject({ kind: "unknown", refusal: { reason: "local_missing" } });
    expect(await a.adapter.reconciliation.readPage({ page: 0, size: 2 })).toMatchObject({ kind: "page", rows: expect.any(Array) });
  }
});

it("refuses transcript tampering before HTTP and projects nested diagnostic/evidence plants", async () => {
  const a = adapter(), req = candidate(), prepared = await a.adapter.dispatch.prepare(req);
  if (prepared.kind !== "prepared") throw Error("expected_preparation");
  for (const transcript of [
    { ...prepared.evidence.transcript!, items: [{ ...prepared.evidence.transcript!.items[0]!, quantity: 9 }] },
    { ...prepared.evidence.transcript!, recipient: req.recipient },
  ]) {
    expect(await a.adapter.dispatch.dispatch(req, { ...prepared.evidence, transcript })).toMatchObject({ kind: "not_dispatched", refusal: { reason: "not_dispatchable" } });
  }
  expect(a.http).not.toHaveBeenCalled(); expect(a.credentials).not.toHaveBeenCalled();
  const f = dispatchFixture();
  const post = vi.spyOn(f.adapter.dispatch, "dispatch").mockImplementation(async (_req, evidence) => ({ kind: "accepted", externalRef: "external-a", evidence: { ...evidence, commandFingerprint: "b".repeat(64) }, ...keys.acceptance() }));
  expect(await f.run()).toMatchObject({ ok: false, reason: "dispatch_acceptance_evidence_mismatch" });
  expect(f.writes[0]).toMatchObject({ kind: "unknown", error: { mayHaveSucceeded: true } });
  expect(await f.run()).toMatchObject({ providerCalls: 0 }); expect(post).toHaveBeenCalledTimes(1);
  const dirty = { kind: "unknown" as const, effectMayHaveSucceeded: true as const, refusal: { reason: "io_failure" as const, phase: "dispatch" as const, retryable: false },
    error: { code: "BAD_SKU", status: 400, retryable: false, mayHaveSucceeded: false, cause: "https://tracking.invalid/?token=fake", message: req.recipient.email } };
  expect(dispatchResult(dirty)).toEqual({ kind: "unknown", effectMayHaveSucceeded: true, refusal: dirty.refusal,
    error: { code: "BAD_SKU", status: 400, retryable: false, mayHaveSucceeded: true, redactedFieldCount: 1 } });
});


it.each([
  { mode: "stage", used: 0 }, { mode: "stage", used: 1 },
  { mode: "shadow", used: 0 }, { mode: "shadow", used: 1 },
] as const)("legacy five-field native attempts preserve $mode migration semantics (used=$used)", async ({ mode, used }) => {
  const a = adapter(), req = candidate(), prepared = await a.adapter.dispatch.prepare(req);
  if (prepared.kind !== "prepared") throw Error("expected_preparation");
  const { commandFingerprint, contactRevision, providerRef, carrierRef, serviceRef } = prepared.evidence;
  const legacy = { commandFingerprint, contactRevision, providerRef, carrierRef, serviceRef };
  const sql = readFileSync(new URL("../../../sql/20261022080000_fulfillment_command_ledger.sql", import.meta.url), "utf8");
  // Model the checked-in native JSONB equality, not the permissive memory store.
  expect(sql).toContain("v_attempt.evidence IS DISTINCT FROM p_evidence");
  expect(sql).toContain("v_ref.evidence IS DISTINCT FROM p_evidence AND v_ref.status='draft'");
  let remaps = used;
  const record: DispatchRecord = { dispatchRef: "dispatch-a", requestKey: keys.request(), fulfillmentRef: req.fulfillmentRef,
    orderRef: req.orderRef, parcelRef: req.parcelRef, mode, status: "draft", externalRef: null, evidence: legacy, replayed: true };
  const attempts = new Map([[keys.mappedAttempt(keys.request(), 0), structuredClone(legacy)]]);
  const query = vi.fn(async (statement: string, values: unknown[] = []) => {
    if (statement.startsWith("UPDATE")) return { rows: [] };
    let response: unknown;
    if (statement.startsWith("SELECT public.fulfillment_dispatch_read")) response = structuredClone(record);
    else if (statement.includes("fulfillment_dispatch_claim(")) {
      const incoming = JSON.parse(values[5] as string);
      if (!isDeepStrictEqual(record.evidence, incoming)) {
        if (remaps >= 1) throw Error("fulfillment_dispatch_remap_exhausted");
        remaps++; record.evidence = incoming;
      }
      response = { kind: "claimed", record: structuredClone(record) };
    } else if (statement.includes("fulfillment_record_provider_attempt(")) {
      const incoming = JSON.parse(values[2] as string), prior = attempts.get(values[0] as string);
      if (prior && !isDeepStrictEqual(prior, incoming)) throw Error("fulfillment_attempt_key_conflict");
      expect(incoming).toEqual(record.evidence);
      response = { replayed: !!prior };
    } else if (statement.includes("fulfillment_dispatch_begin(")) {
      expect(values[1]).toBe(commandFingerprint); record.status = "submitting";
      response = { kind: "begun", begun: true, replayed: false, record: structuredClone(record) };
    } else if (statement.includes("fulfillment_dispatch_finish(")) {
      const acceptance = JSON.parse(values[1] as string);
      expect(acceptance.evidence).toEqual(legacy);
      if (record.acceptance && !isDeepStrictEqual(record.acceptance, acceptance)) throw Error("fulfillment_dispatch_ack_key_conflict");
      const replayed = record.status === "created";
      record.status = "created"; record.externalRef = acceptance.externalRef; record.acceptance = acceptance;
      response = { acknowledged: true, replayed, record: structuredClone(record) };
    } else throw Error("unexpected_query");
    return { rows: [{ response }] };
  });
  const store = createPostgresFulfillmentDispatchStore({ query }, { prepare: async () => ({ disposition: "ready", contactRevision: 1 }), readCandidate: async () => req });
  const prepare = vi.spyOn(a.adapter.dispatch, "prepare");
  const run = () => runFulfillmentDispatchWorker({ store, provider: mode === "shadow" ? null : a.adapter.dispatch, keys, listCandidates: async () => [req], config: { mode, batchLimit: 2 } });
  if (mode === "shadow") {
    expect(await run()).toMatchObject({ ok: false, failures: 1, providerCalls: 0,
      reason: used === 0 ? expect.stringContaining("fulfillment_attempt_key_conflict") : "dispatch_claim_failed" });
    expect(remaps).toBe(1);
    expect(await run()).toMatchObject({ ok: false, failures: 1, providerCalls: 0 });
    expect(prepare).not.toHaveBeenCalled(); expect(a.credentials).not.toHaveBeenCalled(); expect(a.http).not.toHaveBeenCalled();
    return;
  }
  expect(await run()).toMatchObject({ ok: true, failures: 0, providerCalls: 1 });
  expect(await run()).toMatchObject({ ok: true, failures: 0, providerCalls: 0 });
  expect(remaps).toBe(used); expect(a.http).toHaveBeenCalledTimes(1);
});

it("finds a reconciliation row with a compact offset and retains base createdAt parsing", async () => {
  const createdAt = "2026-10-21T09:00:00";
  const f = reconciliationFixture([{ ...row, updatedAt: "2026-10-21T10:00:00+0100", createdAt }]);
  expect(await f.adapter.reconciliation.readPage({ page: 0, size: 2 })).toMatchObject({ kind: "page", rows: [
    { kind: "found", createdAt: new Date(createdAt).toISOString(), updatedAt: "2026-10-21T09:00:00.000Z",
      observation: { fact: { occurredAt: "2026-10-21T09:00:00.000Z" } } },
  ] });
});

it.each(["not-a-time", "2026-02-30T12:00:00Z"])("invalid occurrence %s becomes null without poisoning a valid sibling", async updatedAt => {
  const f = reconciliationFixture([row, { ...row, orderId: "external-b", updatedAt }]);
  const seen: unknown[] = [], record = f.input.lifecycle.recordStatusEvidence;
  f.input.lifecycle.recordStatusEvidence = async (ref, observation) => { seen.push(observation.fact.occurredAt); return record(ref, observation); };
  const result = await runFulfillmentReconciliationPage({ ...f.input, provider: f.adapter.reconciliation, pageSize: 2, checkpoint: null });
  expect(result).toMatchObject({ result: { ok: true, checked: 2, updated: 2, providerCalls: 1 }, metadata: { reconciliationPagination: { nextPage: 1 } } });
  expect(seen).toEqual([now, null]);
});
it("row mapping refusal retains page cardinality and processes a valid sibling", async () => {
  const f = reconciliationFixture([row, { ...row, orderId: "", orderNumber: "", fulfilmentNumber: "" }]);
  const page = await f.adapter.reconciliation.readPage({ page: 0, size: 2 });
  expect(page).toMatchObject({ kind: "page", rows: [{ kind: "found" }, { kind: "unknown", refusal: { reason: "malformed" } }] });
  const result = await runFulfillmentReconciliationPage({ ...f.input, provider: { readPage: async () => page }, pageSize: 2, checkpoint: null });
  expect(result).toMatchObject({ result: { ok: false, checked: 2, updated: 1, failures: 1, providerCalls: 1 }, metadata: { reconciliationPagination: { nextPage: 1 } } });
  expect(f.trace.filter(step => step === "ack")).toHaveLength(1);
});
it("a full found/unknown page attempts the recognized row before advancing", async () => {
  const f = reconciliationFixture(), page = await f.adapter.reconciliation.readPage({ page: 0, size: 2 });
  if (page.kind !== "page") throw Error("expected_page");
  const provider = { readPage: async () => ({ kind: "page" as const, rows: [page.rows[0]!, { kind: "unknown" as const, refusal: { reason: "io_failure" as const, phase: "readback" as const, retryable: true } }] }) };
  expect(await runFulfillmentReconciliationPage({ ...f.input, provider, pageSize: 2, checkpoint: null })).toMatchObject({ result: { checked: 2, updated: 1, failures: 1 }, metadata: { reconciliationPagination: { nextPage: 1 } } });
  expect(f.trace).toContain("find"); expect(f.trace).toContain("ack");
});
it("a pre-traversal abort retains the current page", async () => {
  const f = reconciliationFixture();
  const provider = { readPage: async () => ({ kind: "page" as const, rows: null as never }) };
  expect(await runFulfillmentReconciliationPage({ ...f.input, provider, pageSize: 2, checkpoint: { reconciliationPagination: { version: 1, pageSize: 2, page: 2, nextPage: 3 } } })).toMatchObject({ result: { checked: 0, failures: 1, providerCalls: 1 }, metadata: { reconciliationPagination: { page: 3, nextPage: 3 } } });
  expect(f.trace).toEqual([]);
});
it("a thrown page read counts one logical provider call", async () => {
  const f = reconciliationFixture();
  expect(await runFulfillmentReconciliationPage({ ...f.input, provider: { readPage: async () => { throw Error("read_down"); } }, pageSize: 2, checkpoint: null })).toMatchObject({ result: { providerCalls: 1, failures: 1, checked: 0 } });
});


it("native observation ingestion preserves host event identity and RFC3339 offset timestamps", async () => {
  const receivedAt = "2026-10-22T19:00:00+02:00", fixture = observation();
  const event = { ...fixture, eventKey: "host/event:+02:00", firstReceivedAt: receivedAt,
    correlation: { ...fixture.correlation, orderRef: "host/order", fulfillmentRef: "host/fulfillment", parcelRef: "host/parcel" },
    diagnostics: { recoveredPickedReceipt: { receiptRef: "host/receipt", closed: true } },
    fact: { ...fixture.fact, receivedAt, occurredAt: receivedAt } };
  const writes: unknown[][] = [];
  const native = createPostgresFulfillmentShipmentSpinePort({ async query(_statement, values = []) {
    assertNativeObservation(values); writes.push(values); return { rows: [{ response: { replayed: writes.length > 1 } }] };
  } }, { portKey: "timestamp-test" }).localPersistence;
  expect(await native.recordObservation(event)).toEqual({ replayed: false });
  expect(await native.recordObservation(projectObservation(event))).toEqual({ replayed: true });
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]![0]).toBe(event.eventKey); expect(writes[0]![3]).toBe(receivedAt);
  expect(JSON.parse(writes[0]![2] as string).correlation).toEqual(event.correlation);
  expect(JSON.parse(writes[0]![2] as string).diagnostics.recoveredPickedReceipt).toEqual(event.diagnostics.recoveredPickedReceipt);
  expect(JSON.parse(writes[0]![2] as string).diagnostics?.redactedFieldCount).toBe(1); // unapproved tracking URL only
  await expect(native.recordObservation({ ...event, firstReceivedAt: "redacted" })).rejects.toThrow();
  expect(writes).toHaveLength(2);
});
it("diagnostic codecs count refused fields once", async () => {
  const privacy = durableStrings();
  expect(localFailureReason("stage", { code: "bad/code", causeMessage: "bad.code" }, privacy)).toBe("stage");
  expect(privacy.redactedFieldCount).toBe(2);
  const f = reconciliationFixture();
  f.input.lifecycle.issueAccountingInvoice = async () => { throw Error("invoice_rpc_failed"); };
  f.input.lifecycle.invoiceFailure = () => ({ permanent: true, identifier: "bad/code", sqlstate: "bad.code", benign: false });
  expect(await f.run()).toMatchObject({ redactedFieldCount: 2, invoiceIssueRefusals: [{ identifier: null, sqlstate: "22023" }] });
});
it("sweeps every provider string field through adapters, workers and durable sink projections", async () => {
  const plants = ["Jane Doe +12025550123", "jane.doe@example.invalid", "12 Example Street", '{"contact":{"email":"jane@example.invalid","phone":"+12025550123"}}', "Bearer synthetic.secret/contact+token="];
  // All strings read from PR2 provider inputs, including fallback spellings and
  // mapper fields not currently retained. Each field is poisoned independently.
  const reconciliationFields = [
    "orderId", "providerOrderId", "fulfilmentNumber", "externalNumber", "orderNumber", "createdAt", "updatedAt", "status", "subStatus",
    "trackingNumbers.0", "shipments.0.trackingNo", "shipments.0.trackingNumber",
    "shipments.0.trackingUrl", "shipments.0.trackingURL", "shipments.0.trackingLink", "shipments.0.publicTrackingUrl",
    "shipments.0.carrier", "shipments.0.carrierCode", "shipments.0.shippingMethod", "shipments.0.service",
    "items.0.sku", "items.0.productLotNumber", "items.0.expirationDate",
  ];
  const dispatchFields = ["resolveProduct.lotNumber", "resolveProduct.expirationDate", "response.orderId", "error.code"];
  const diagnosticFields = ["message", "code", "causeCode", "causeMessage"];
  const set = (value: Record<string, unknown>, path: string, text: string) => {
    const parts = path.split("."); let target = value;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = text;
  };
  const statusKeys: string[] = [], subStatusKeys: string[] = [];
  const sinks = new Set<string>();
  for (const plant of plants) {
    const captured: { sink: string; value: unknown }[] = [];
    const capture = (sink: string, value: unknown) => { sinks.add(sink); captured.push({ sink, value: structuredClone(value) }); };
    for (const field of reconciliationFields) {
      const poisoned: Record<string, unknown> = { ...row, status: "delivered", shipments: [{ trackingNo: "TRACK-A" }],
        trackingNumbers: ["TRACK-B"], items: [{ sku: "SKU-A", productLotNumber: "LOT-A", expirationDate: "2027-01-01" }] };
      if (field === "providerOrderId") delete poisoned.orderId;
      if (field === "shipments.0.trackingNumber") delete (poisoned.shipments as Record<string, unknown>[])[0]!.trackingNo;
      set(poisoned, field, plant);
      const f = reconciliationFixture([poisoned as typeof row]);
      f.input.lifecycle.trackingCodecs = { normalizeCarrier: value => value.carrierRef, publicUrl: () => null };
      f.input.lifecycle.readDeliveryCarrier = async () => null;
      const native = createPostgresFulfillmentShipmentSpinePort({ async query(statement, values) {
        if (field === "subStatus" && statement.includes("fulfillment_record_observation(")) expect(JSON.parse(values![2] as string).diagnostics.redactedFieldCount).toBe(1);
        if (statement.includes("fulfillment_record_observation(")) assertNativeObservation(values!);
        capture("native-observation", { statement, values }); return { rows: [{ response: { replayed: false } }] };
      } }, { portKey: "privacy-test" }).localPersistence;
      f.input.lifecycle.acknowledgeDispatchAcceptance = async (ref, evidence) => capture("ack-evidence", { ref, evidence });
      f.input.lifecycle.recordQuarantine = async (evidence, reason) => { capture("quarantine", { evidence, reason }); return { replayed: false }; };
      f.input.lifecycle.recordStatusEvidence = async (ref, evidence) => {
        capture("provider-status", evidence);
        if (field === "subStatus") { subStatusKeys.push(evidence.eventKey); expect(evidence.diagnostics?.redactedFieldCount).toBe(1); }
        await native.recordObservation(evidence);
        return native.recordStatusEvidence(ref, evidence);
      };
      for (const effect of ["markProviderStockConsumed", "markHandedOver", "recordTrackingReference"] as const) {
        f.input.lifecycle.effects[effect] = async value => { capture("effect", value); return { replayed: false, readBack: false }; };
      }
      const quarantine = f.input.lifecycle.recordQuarantine;
      f.input.lifecycle.recordQuarantine = async (evidence, reason, detail) => {
        if (field === "status") { statusKeys.push(evidence!.eventKey); expect(evidence!.diagnostics?.redactedFieldCount).toBe(1); }
        return quarantine(evidence, reason, detail);
      };
      const run = await runFulfillmentReconciliationPage({ ...f.input, provider: f.adapter.reconciliation, pageSize: 1,
        checkpoint: { extra: plant, reconciliationPagination: { version: 1, page: 0, nextPage: 0, pageSize: 1, extra: plant } } });
      expect(run.result).toMatchObject({ checked: 1, failures: 0, quarantined: field === "status" ? 1 : 0, updated: field === "status" ? 0 : 1 });
      capture("checkpoint-and-diagnostics", run);
    }
    for (const field of dispatchFields) {
      const metadata = { lotNumber: "LOT-A", expirationDate: "2027-01-01" }, response = { orderId: "external-a" };
      if (field.startsWith("resolveProduct.")) set(metadata, field.split(".")[1]!, plant);
      if (field === "response.orderId") response.orderId = plant;
      const a = adapter(() => field === "error.code" ? Response.json({ code: plant }, { status: 400 }) : Response.json(response), metadata);
      const { native, memory, receipts } = nativeDispatchFixture(capture);
      const replayKeys = { ...keys, acceptance: () => ({ providerAttemptKey: "host:attempt/accepted", labelKey: "host/label:ack" }) };
      const run = await runFulfillmentDispatchWorker({ store: native, provider: a.adapter.dispatch, keys: replayKeys,
        listCandidates: async () => [candidate()], config: { mode: "stage", batchLimit: 1 } });
      expect(run.providerCalls).toBe(1);
      if (field.startsWith("resolveProduct.")) {
        for (let replay = 0; replay < 2; replay++) {
          const result = await runFulfillmentDispatchWorker({ store: native, provider: a.adapter.dispatch, keys: replayKeys,
            listCandidates: async () => [candidate()], config: { mode: "stage", batchLimit: 1 } });
          expect(result, `${field}: ${JSON.stringify(result)}`).toMatchObject({ ok: true, failures: 0, providerCalls: 0, replayed: 1 });
        }
        expect(receipts).toHaveLength(3);
        expect(receipts[1]).toEqual(receipts[0]); expect(receipts[2]).toEqual(receipts[0]);
        expect(receipts[0]).toMatchObject(replayKeys.acceptance());
        expect(a.http).toHaveBeenCalledTimes(1);
      }
      const attempts = await memory.readMappedAttempts(); expect(attempts).toHaveLength(1);
      if (field.startsWith("resolveProduct.")) expect(attempts[0]!.preparedEvidence.transcript!.redactedFieldCount).toBe(1);
      capture("transcript", attempts); capture("dispatch-diagnostics", run);
      // The same transcript projection also guards provider-free shadow writes.
      const req = candidate(); req.lines = [{ ...req.lines[0]!, lotRef: plant, expirationDate: plant }];
      const shadow = memoryStore(); shadow.readCandidate = async () => req;
      capture("shadow-diagnostics", await runFulfillmentDispatchWorker({ store: shadow, provider: null, keys, listCandidates: async () => [req], config: { mode: "shadow", batchLimit: 1 } }));
      capture("transcript", await shadow.readMappedAttempts());
    }
    // Exception fields read by both workers and the reconciliation invoice codec.
    for (const field of diagnosticFields) {
      const error = Object.assign(Error("operation_failed"), { [field]: plant });
      const f = dispatchFixture(); f.store.markStaleSubmissionsUncertain = async () => { throw error; };
      capture("dispatch-diagnostics", await f.run());
      const recovery = nativeDispatchFixture(capture, error), a = adapter();
      const recover = () => runFulfillmentDispatchWorker({ store: recovery.native, provider: a.adapter.dispatch, keys,
        listCandidates: async () => [candidate()], config: { mode: "stage", batchLimit: 1 } });
      expect(await recover()).toMatchObject({ ok: false, providerCalls: 1 });
      const persisted = await recovery.native.read(keys.request());
      expect(persisted).toMatchObject({ status: "uncertain", acceptance: { error: { code: "dispatch_acceptance_write_failed", redactedFieldCount: 1 } } });
      capture("accepted-ack-recovery-readback", persisted);
      expect(await recover()).toMatchObject({ ok: true, providerCalls: 0 });
      expect(await recover()).toMatchObject({ ok: true, providerCalls: 0 });
      expect(recovery.receipts[1]).toEqual(recovery.receipts[0]);
      expect(a.http).toHaveBeenCalledTimes(1);
      const r = reconciliationFixture(); r.input.lifecycle.issueAccountingInvoice = async () => { throw error; };
      r.input.lifecycle.invoiceFailure = () => ({ permanent: true, identifier: plant, sqlstate: plant, benign: false });
      capture("reconciliation-diagnostics", await r.run());
      capture("checkpoint-and-diagnostics", await runFulfillmentReconciliationPage({ ...r.input, provider: { readPage: async () => { throw error; } }, pageSize: 1, checkpoint: null }));
    }
    const exception = reconciliationFixture([{ ...row, status: "shipping_failed", subStatus: plant }]);
    exception.input.lifecycle.recordProviderException = async (ref, evidence) => {
      capture("provider-exception", { ref, evidence });
      expect(evidence.providerStatus).toEqual({ primary: "shipping_failed", subStatus: null });
      expect(evidence.diagnostics?.redactedFieldCount).toBe(1);
      return { replayed: false };
    };
    expect(await exception.run()).toMatchObject({ ok: true, exceptions: 1 });
    const bytes = JSON.stringify(captured);
    for (const forbidden of plants) {
      expect(bytes).not.toContain(forbidden);
      expect(bytes).not.toContain(JSON.stringify(forbidden).slice(1, -1));
      expect(bytes.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  }
  // Machine tokens survive; only the adopter's explicit URL policy permits a URL
  // through both the worker projection and repeated native observation projection.
  const tokens = reconciliationFixture([{ ...row, status: "IN_TRANSIT" }]);
  tokens.input.lifecycle.recordQuarantine = async evidence => {
    expect(evidence!.providerStatus!.primary).toBe("IN_TRANSIT"); return { replayed: false };
  };
  expect(await tokens.run()).toMatchObject({ quarantined: 1 });
  const approved = reconciliationFixture(), nativeWrites: unknown[][] = [];
  const policy = (url: string) => url === "https://tracking.invalid/TRACK-A";
  const native = createPostgresFulfillmentShipmentSpinePort({ async query(_statement, values = []) {
    assertNativeObservation(values); nativeWrites.push(values); return { rows: [{ response: { replayed: false } }] };
  } }, { portKey: "privacy-test", approveTrackingUrl: policy }).localPersistence;
  approved.input.lifecycle.recordStatusEvidence = async (_ref, evidence) => native.recordObservation(evidence);
  expect(await approved.run()).toMatchObject({ ok: true, trackingRefs: 1 });
  expect(JSON.parse(nativeWrites[0]![2] as string).trackingRefs[0].publicUrl).toBe(row.shipments[0]!.trackingUrl);
  expect(new Set(statusKeys).size).toBe(plants.length);
  expect(new Set(subStatusKeys).size).toBe(plants.length);
  expect([...sinks]).toEqual(expect.arrayContaining(["native-dispatch", "native-observation", "provider-status", "quarantine", "ack-evidence", "effect", "transcript", "checkpoint-and-diagnostics", "dispatch-diagnostics", "reconciliation-diagnostics", "provider-exception", "accepted-ack-recovery", "accepted-ack-recovery-readback"]));
});
