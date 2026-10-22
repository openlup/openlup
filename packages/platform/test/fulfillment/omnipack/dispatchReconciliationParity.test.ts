import { expect, it, vi } from "vitest";
import type { DispatchRecord, FulfillmentDispatchRequest, FulfillmentDispatchResult } from "../../../src/fulfillment/contracts/index.js";
import { createFulfillmentServices, createPostgresFulfillmentDispatchStore, reconcileFulfillmentObservations, runFulfillmentDispatchWorker, runFulfillmentReconciliationPage } from "../../../src/fulfillment/index.js";
import { createOmnipackFulfillmentAdapter } from "../../../src/fulfillment/omnipack/index.js";
import { dispatchResult } from "../../../src/fulfillment/dispatchProjection.js";
import { ingressFixture, memoryStore, profile, request } from "../fixtures.js";

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
function adapter(reply: (url: URL, init: RequestInit) => Response | Promise<Response> = () => Response.json({ orderId: "external-a" })) {
  const http = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => reply(new URL(String(url)), init!));
  const credentials = vi.fn(() => ({ username: "fake", password: "fake" }));
  return { http, credentials, adapter: createOmnipackFulfillmentAdapter({ http: { baseUrl: "https://warehouse.invalid", fetchImpl: http, credentials, timeoutMs: 5, safeReadRetries: 1, productPath: "/products" },
    selected: true, readiness: { ready: true }, resolveProduct: async () => ({ lotNumber: "LOT-A", expirationDate: "2027-01-01" }),
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
    refusal: { reason: "io_failure", phase: "dispatch", retryable: false }, error: { code: spec.code, status: spec.status, retryable: false, mayHaveSucceeded: spec.ambiguous } });
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
      async readDeliveryCarrier() { throw Error("unused_read"); }, trackingCodecs: { normalizeCarrier: value => value.carrierRef, publicUrl: () => null },
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
  expect(aborted).toMatchObject({ status: 502, result: { checked: 2 }, metadata: { reconciliationPagination: { nextPage: 1 } } });
  const end = await runFulfillmentReconciliationPage({ ...f.input, provider: a.adapter.reconciliation, pageSize: 2, checkpoint: { reconciliationPagination: { version: 1, page: 1, nextPage: 2, pageSize: 2 } } });
  expect(end).toMatchObject({ status: 200, result: { checked: 0 }, metadata: { reconciliationPagination: { nextPage: 0 } } });
});
it.each(["ERR_PAGE_MUST_BE_LESS_THAN_TOTAL_PAGES", "OTHER_ERROR"])("page 400 %s has the exact exhausted-page classification", async code => {
  const f = reconciliationFixture(), a = adapter(() => Response.json({ code }, { status: 400 }));
  const result = await runFulfillmentReconciliationPage({ ...f.input, provider: a.adapter.reconciliation, pageSize: 2, checkpoint: { reconciliationPagination: { version: 1, page: 1, nextPage: 2, pageSize: 2 } } });
  expect(result).toMatchObject({ status: code === "OTHER_ERROR" ? 502 : 200, result: { ok: code !== "OTHER_ERROR", checked: 0, reason: code === "OTHER_ERROR" ? code : "page_exhausted" }, metadata: { reconciliationPagination: { page: 2, nextPage: 0 } } });
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
    error: { code: "BAD_SKU", status: 400, retryable: false, mayHaveSucceeded: true } });
});
