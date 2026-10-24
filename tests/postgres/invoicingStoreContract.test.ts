import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPostgresInvoiceStore, runNativeInvoiceIssueJob } from "@openlup/platform/invoicing";
import type { InvoiceFacts, InvoiceHostPorts, InvoiceIdentity, InvoiceProviderPort, InvoiceStorePort } from "@openlup/platform/invoicing/contracts";
import { invoicingNativeHarness } from "../helpers/invoicingNativeHarness.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

// P4 acceptance: pinned native store + issue binding (checks 2–5). Each row
// checks the returned port/job result AND the installed SQL's durable state.
// Existing six conformance cases and their 28 s budget remain in their own file.
const h = invoicingNativeHarness();
let started: number;
beforeAll(async () => { await h.start(); started = performance.now(); }, postgresSetupTimeoutMs);
afterAll(async () => { await h.stop(); console.log(`M09 adapter contract whole-file ms=${Math.round(performance.now() - started)}`); }, postgresTeardownTimeoutMs);
const executor = { query: (sql: string, values?: unknown[]) => h.pool.query(sql, values) };
const seller = { name: "Contract seller", address: { line1: "Seller street", postalCode: "12345", city: "Seller city" }, taxIdentifier: { scheme: "host-id", value: "seller-tax" }, bankAccount: "seller-bank", routingRef: "seller-route" };
const sellerRevision = "seller-contract-first";
const sellerBinding = { read: async () => ({ kind: "found" as const, seller, revisionRef: sellerRevision }) };
const store = createPostgresInvoiceStore(executor, { seller: sellerBinding });
type Claim = Parameters<InvoiceStorePort["preflight"]>[0]["claim"];
type Money = Awaited<ReturnType<InvoiceHostPorts["money"]["read"]>>;
const proof = { evidenceRef: "contract-proof", fingerprint: "b".repeat(64), observedAt: "2026-10-21T13:14:15Z" };
const providerRef = "invoice-provider";
const reason = "order_refunded" as const;
const zero = { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 } as const;
function facts(orderId: string, intentRef: string): InvoiceFacts {
  return {
    factRevision: "fiscal-revision", policyVersion: "fiscal-policy", documentKind: "host-document", clearanceRequired: false,
    refs: { orderId, orderRef: `ORDER/${orderId}`, invoiceRef: `INVOICE/${orderId}` }, currency: "XXX",
    dates: { issueDate: "2026-10-22", sellDate: "2026-10-20", handedOverAt: "2026-10-19T10:11:12Z", paymentCompletedAt: "2026-10-18T09:08:07Z" },
    buyer: { name: "Saved buyer", email: "buyer@example.invalid", taxIdentifier: null, companyName: "Buyer company", address: null },
    payment: { intentRef, providerRef: "money-provider", providerPaymentRef: "remote-payment", amountMinor: 907, currency: "XXX", localSettlementState: "matched" },
    orderMoney: { subtotalMinor: 941, discountMinor: 43, shippingMinor: 47, shippingDiscountMinor: 45, totalMinor: 900 },
    lines: [
      { description: "First position", quantity: 2, unitNetMinor: 100, unitGrossMinor: 120, totalNetMinor: 200, totalTaxMinor: 40, totalGrossMinor: 240, taxRateBps: 2000, positionKind: "item", catalogTotalGrossMinor: 251, discountAllocatedMinor: 11, shippingGrossMinor: 13, shippingDiscountMinor: 17 },
      { description: "Second position", quantity: 3, unitNetMinor: 190, unitGrossMinor: 220, totalNetMinor: 570, totalTaxMinor: 90, totalGrossMinor: 660, taxRateBps: 1579, positionKind: "delivery", catalogTotalGrossMinor: 683, discountAllocatedMinor: 23, shippingGrossMinor: 29, shippingDiscountMinor: 31 },
    ],
    totalNetMinor: 770, totalTaxMinor: 130, totalGrossMinor: 900, chargedTotalGrossMinor: 900,
  };
}
function identity(dutyId: string, requestKey: string, saved: InvoiceFacts, parent: string | null): InvoiceIdentity {
  return { providerRef, requestKey, providerCreateIdentity: `invoicing:${dutyId}`, factRevision: saved.factRevision,
    orderRef: saved.refs.orderRef, invoiceRef: saved.refs.invoiceRef, operation: parent ? "full_reversal" : "issue",
    correctionRef: parent ? `invoicing:${dutyId}` : null, parentProviderDocumentRef: parent };
}
async function claim(orderId: string, selectedStore = store) {
  const result = await selectedStore.claim({ orderId, providerRef, limit: 1, visibilitySeconds: 83 });
  if ("kind" in result || result.length !== 1) throw new Error(`Expected one contract claim for ${orderId}`);
  return result[0]!;
}
async function state(dutyId: string) {
  return (await h.pool.query(`SELECT d.id,d.order_id,d.document_id,d.request_id,d.parent_duty_id,d.original_key,d.provider,
    d.status,d.generation,d.claim_token,d.lease_until,d.preflight_generation,d.last_result,d.reversal,
    r.status AS request_status,r.attempts,r.claim_token AS request_token,r.available_at::text AS request_available,
    a.status AS document_status,a.provider_reference,a.total_gross_minor,a.correction_of_document_id
    FROM public.invoicing_duties d LEFT JOIN public.accounting_document_requests r ON r.id=d.request_id
    LEFT JOIN public.accounting_documents a ON a.id=d.document_id WHERE d.id=$1`, [dutyId])).rows[0]!;
}
async function seed() {
  const client = randomUUID(), orderId = randomUUID(), intent = randomUUID(), sourceId = randomUUID();
  await h.pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  const db = await h.pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)", [orderId, client]);
    await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,2,120,240),($1,2,3,220,660)", [orderId]);
    await db.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'contract',900,'XXX',$3)", [intent, orderId, `open:${intent}`]);
    await db.query("SELECT public.commerce_record_settlement($1,$2,'succeeded',NULL,'{}',now())", [`paid:${intent}`, intent]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  const requestKey = ` exact capture:${orderId} `;
  const capture = { requestKey, sourceKind: "paid" as const, sourceId, orderId, occurredAt: "2026-10-18T09:08:07Z", evidence: { settlementIntentId: intent, amountMinor: 900, currency: "XXX" } };
  const captured = await store.captureDuty(capture);
  if ("kind" in captured) throw new Error("Capture refused");
  const dutyId = captured.dutyId;
  expect(captured).toEqual({ dutyId, status: "owed" });
  expect(await store.captureDuty(capture)).toEqual(captured);
  expect(await state(dutyId)).toMatchObject({ order_id: orderId, original_key: requestKey, status: "owed", generation: 0, request_id: null, document_id: null, last_result: null, reversal: null });
  expect((await h.pool.query("SELECT payload FROM public.invoicing_effect_receipts WHERE receipt_key=$1", [`source:paid:${sourceId}`])).rows).toEqual([{ payload: {
    sourceKind: "paid", sourceId, orderId, evidence: capture.evidence, occurredAt: "2026-10-18T09:08:07.000000Z",
  } }]);
  const saved = facts(orderId, intent);
  expect(await store.installFacts({ dutyId, facts: saved })).toEqual({ dutyId, status: "owed" });
  expect(await store.installFacts({ dutyId, facts: saved })).toEqual({ dutyId, status: "owed", replayed: true });
  expect((await h.pool.query("SELECT revision_ref,facts FROM public.invoicing_fact_revisions WHERE duty_id=$1", [dutyId])).rows).toEqual([{ revision_ref: saved.factRevision, facts: saved }]);
  const swept = await store.sweep(100);
  if ("kind" in swept) throw new Error("Sweep refused");
  const lease = swept.claims.find(v => v.dutyId === dutyId)!;
  const prepared = await store.prepareFacts(lease);
  expect(prepared).toMatchObject({ status: "ready" });
  if ("kind" in prepared || prepared.status !== "ready") throw new Error("Preparation refused");
  expect(await store.finishFacts({ ...lease, result: { ...prepared, status: prepared.status } })).toEqual({ dutyId, status: "ready" });
  expect(await state(dutyId)).toMatchObject({ status: "ready", generation: 0, last_result: null, request_status: "pending", attempts: 0, document_status: "issue_requested", provider_reference: null, reversal: null });
  return { dutyId, orderId, saved, requestKey, capture };
}
const positive = (id: InvoiceIdentity, kind: "issued" | "found" = "issued") => ({ kind, identity: id,
  providerDocumentRef: `external:${id.providerCreateIdentity}`, providerDocumentNumber: `NUMBER/${id.invoiceRef}`, proof, replayed: false });
async function correction(base: Awaited<ReturnType<typeof seed>>) {
  const parentClaim = await claim(base.orderId);
  expect(await store.preflight({ claim: parentClaim, status: "succeeded", amountMinor: 900, currency: "XXX", proof })).toEqual({ kind: "ready" });
  expect(await store.finish({ claim: parentClaim, result: { ...positive(parentClaim.identity), kind: "issued" } })).toEqual({ kind: "issued", replayed: false });
  const requestKey = ` exact reversal:${base.orderId} `;
  const reversal = { requestKey, orderId: base.orderId, reason, proof };
  const result = await store.requestReversal(reversal);
  if (result.kind !== "correction_requested" || !result.dutyId) throw new Error("Correction missing");
  expect(result).toEqual({ kind: "correction_requested", dutyId: result.dutyId, replayed: false });
  expect(await store.requestReversal(reversal)).toEqual({ ...result, replayed: true });
  expect(await state(base.dutyId)).toMatchObject({ status: "issued", document_status: "correction_requested", reversal: { key: requestKey, reason, evidence: { ...proof, reason, sellerPolicyVersion: "invoicing.seller.v1" } } });
  expect(await state(result.dutyId)).toMatchObject({ parent_duty_id: base.dutyId, original_key: requestKey, status: "ready", generation: 0, last_result: null,
    request_status: "pending", attempts: 0, document_status: "draft", reversal: null });
  return { ...base, dutyId: result.dutyId, requestKey, parent: positive(parentClaim.identity).providerDocumentRef, baseDutyId: base.dutyId };
}
type Arm = "issued" | "retryable" | "blocked" | "unsupported" | "unknown" | "found" | "absent" | "read_unknown" | "read_unsupported" |
  "finish_unsupported" | "stale_local" | "stale_fresh" | "stale_finish" | "stale_fail" | "reversal_retryable" | "reversal_absent" | "reversal_found" | "reversal_missing" | "reversal_voided" | "reversal_unsupported";
type Evidence = "succeeded" | "failed" | "pending" | "absent" | "unavailable" | "unknown" | "amount_mismatch" | "currency_mismatch";
type Row = { name: string; correction: boolean; arm: Arm; generation?: number; local?: Evidence; fresh?: Evidence };
const rows: Row[] = [false, true].flatMap(isCorrection => {
  const prefix = isCorrection ? "correction" : "issue";
  const make = (name: string, rest: Omit<Row, "name" | "correction">): Row => ({ name: `${prefix}/${name}`, correction: isCorrection, ...rest });
  return [
    ...[1, 2, 3, 4].map(generation => make(`issued/g${generation}`, { arm: "issued", generation })),
    ...(["retryable", "blocked", "unsupported", "unknown", "finish_unsupported", "stale_local", "stale_fresh", "stale_finish", "stale_fail",
      "found", "absent", "read_unknown", "read_unsupported"] as const).map(arm => make(arm, { arm })),
    ...(["succeeded", "failed", "pending", "absent", "unavailable", "unknown", "amount_mismatch", "currency_mismatch"] as const)
      .flatMap(evidence => [make(`local/${evidence}`, { arm: "issued", local: evidence }), make(`fresh/${evidence}`, { arm: "issued", fresh: evidence })]),
  ];
}).concat(( ["reversal_retryable", "reversal_absent", "reversal_found", "reversal_missing", "reversal_voided", "reversal_unsupported"] as const).map(arm => ({ name: `issue/${arm}`, correction: false, arm })));

it.each(rows)("P4 installed adapter contract: $name", async row => {
  const base = await seed();
  if (["reversal_missing", "reversal_voided", "reversal_unsupported"].includes(row.arm)) {
    const snapshot = await state(base.dutyId);
    const missing = row.arm === "reversal_missing", blocked = row.arm === "reversal_unsupported";
    if (blocked) {
      const selected = await claim(base.orderId);
      expect(await store.preflight({ claim: selected, status: "failed", amountMinor: 900, currency: "XXX", proof })).toEqual({ kind: "blocked" });
      expect(await store.fail({ claim: selected, kind: "blocked", proof, retrySeconds: 73 })).toEqual({ kind: "recorded" });
    }
    const reversal = { requestKey: `terminal:${base.orderId}`, orderId: missing ? randomUUID() : base.orderId, reason, proof };
    expect(await store.requestReversal(reversal)).toEqual({ kind: missing ? "missing" : blocked ? "unsupported_recorded" : "voided", ...(!missing && !blocked ? { replayed: false } : {}) });
    if (missing) expect(await state(base.dutyId)).toEqual(snapshot);
    else {
      expect(await state(base.dutyId)).toMatchObject({ status: blocked ? "blocked" : "voided", generation: blocked ? 1 : 0,
        claim_token: null, lease_until: null, request_status: blocked ? "failed" : "discarded", attempts: blocked ? 1 : 0,
        request_token: null, document_status: blocked ? "issue_requested" : "voided", provider_reference: null,
        reversal: { key: reversal.requestKey, reason, evidence: { ...proof, reason, sellerPolicyVersion: "invoicing.seller.v1" } }, last_result: blocked ? { kind: "blocked", evidence: { proof } } : null });
      expect((await h.pool.query("SELECT payload FROM public.invoicing_effect_receipts WHERE receipt_key=$1", [`reversal-key:${reversal.requestKey}`])).rows)
        .toEqual([{ payload: { key: reversal.requestKey, reason, evidence: { ...proof, reason, sellerPolicyVersion: "invoicing.seller.v1" } } }]);
    }
    expect((await h.pool.query("SELECT id FROM public.accounting_documents WHERE order_id=$1", [base.orderId])).rows).toHaveLength(1);
    return;
  }
  const f = row.correction ? await correction(base) : { ...base, parent: null, baseDutyId: null };
  const claimedSeller = row.correction ? { ...seller, name: "Correction contract seller" } : seller;
  const claimedRevision = row.correction ? "seller-correction-first" : sellerRevision;
  const selectedStore = createPostgresInvoiceStore(executor, { seller: { read: async () => ({ kind: "found", seller: claimedSeller, revisionRef: claimedRevision }) } });
  const expectedIdentity = identity(f.dutyId, f.requestKey, f.saved, f.parent);
  const readback = ["found", "absent", "read_unknown", "read_unsupported", "reversal_absent", "reversal_found"].includes(row.arm);
  const generation = row.generation ?? (readback ? 2 : 1);
  // Advance through genuine SQL leases and failures, preserving the request fence.
  for (let prior = 1; prior < generation; prior++) {
    const leased = await claim(f.orderId, selectedStore);
    expect(leased.generation).toBe(prior);
    expect(await selectedStore.fail(readback ? { claim: leased, kind: "unknown", proof, retrySeconds: 0 }
      : { claim: leased, kind: "retryable", phase: "before_send", proof, retrySeconds: 0 })).toEqual({ kind: "recorded" });
  }
  let reversal: { key: string; reason: string; evidence: typeof proof & { reason: string; sellerPolicyVersion: string } } | null = null;
  if (row.arm === "reversal_absent" || row.arm === "reversal_found") {
    reversal = { key: `pending:${f.orderId}`, reason, evidence: { ...proof, reason, sellerPolicyVersion: "invoicing.seller.v1" } };
    expect(await selectedStore.requestReversal({ requestKey: reversal.key, orderId: f.orderId, reason, proof })).toEqual({ kind: "pending_readback" });
  }
  const evidence = (variant: Evidence = "succeeded"): Money => variant === "absent" ? { kind: "absent", evidence: { ...proof, exact: true, complete: true,
    scope: { intentRef: f.saved.payment.intentRef, providerRef: "money-provider", providerPaymentRef: "remote-payment", expectedMoney: { amountMinor: 900, currency: "XXX" } } } }
    : variant === "unavailable" || variant === "unknown" ? { kind: variant, code: "money_unavailable" }
      : { kind: "observed", status: variant === "failed" || variant === "pending" ? variant : "succeeded",
        amountMinor: variant === "amount_mismatch" ? 907 : 900, currency: variant === "currency_mismatch" ? "YYY" : "XXX", proof };
  const expire = async () => { await h.pool.query("UPDATE public.invoicing_duties SET lease_until=now()-interval '1 second' WHERE id=$1", [f.dutyId]); };
  const io: string[] = [];
  const readLocalPayment = vi.fn(async (_claim: Claim) => {
    io.push("local"); if (row.arm === "stale_local") await expire(); return evidence(row.local ?? "unavailable");
  });
  const money = { read: vi.fn<InvoiceHostPorts["money"]["read"]>(async () => {
    io.push("money"); if (row.arm === "stale_fresh") await expire(); return evidence(row.fresh);
  }) };
  const write = async (id: InvoiceIdentity) => {
    if (row.arm === "stale_finish" || row.arm === "stale_fail") await expire();
    if (row.arm === "reversal_retryable") {
      reversal = { key: `inflight:${f.orderId}`, reason, evidence: { ...proof, reason, sellerPolicyVersion: "invoicing.seller.v1" } };
      expect(await selectedStore.requestReversal({ requestKey: reversal.key, orderId: f.orderId, reason, proof })).toEqual({ kind: "pending_readback" });
    }
    if (row.arm === "retryable" || row.arm === "blocked" || row.arm === "stale_fail" || row.arm === "reversal_retryable") return {
      kind: "refused" as const, identity: id, code: "blocked" as const, retryable: row.arm !== "blocked", effectMayHaveSucceeded: false as const,
    };
    if (row.arm === "unsupported") return { kind: "unsupported" as const, code: "unsupported" as const, retryable: false as const, effectMayHaveSucceeded: false as const };
    if (row.arm === "unknown") return { kind: "unknown" as const, identity: id, code: "unknown" as const, effectMayHaveSucceeded: true as const };
    return { ...positive(row.arm === "finish_unsupported" ? { ...id, requestKey: "foreign-key" } : id), kind: "issued" as const };
  };
  const provider = {
    issue: vi.fn<InvoiceProviderPort["issue"]>(async input => { io.push("issue"); return write(input.identity); }),
    correct: vi.fn<InvoiceProviderPort["correct"]>(async input => { io.push("correct"); return write(input.identity); }),
    read: vi.fn<InvoiceProviderPort["read"]>(async id => {
      io.push("read");
      if (row.arm === "absent" || row.arm === "reversal_absent") return { kind: "absent", identity: id, evidence: { ...proof, exact: true, complete: true, scope: id } };
      if (row.arm === "read_unknown") return { kind: "unknown", identity: id, code: "unknown" };
      if (row.arm === "read_unsupported") return { kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false };
      return { ...positive(id), kind: "found" };
    }),
  };
  // Spies record real port calls; no SQL responses or store decisions are faked.
  const bound = { ...selectedStore, claim: vi.fn(selectedStore.claim), preflight: vi.fn(selectedStore.preflight), finish: vi.fn(selectedStore.finish), fail: vi.fn(selectedStore.fail) };
  const localBlocked = ["failed", "pending", "amount_mismatch", "currency_mismatch"].includes(row.local ?? "");
  const freshBlocked = ["failed", "pending", "amount_mismatch", "currency_mismatch"].includes(row.fresh ?? "");
  const freshUnavailable = ["absent", "unavailable", "unknown"].includes(row.fresh ?? "");
  const stale = row.arm.startsWith("stale_");
  const success = !localBlocked && !freshBlocked && !freshUnavailable && ["issued", "found", "reversal_found"].includes(row.arm);
  expect(await runNativeInvoiceIssueJob({ store: bound, provider, money, readLocalPayment, providerRef, orderId: f.orderId, limit: 1, visibilitySeconds: 83 }))
    .toEqual({ checked: 1, updated: success ? 1 : 0, failures: success ? 0 : 1, ok: success });
  const claims = await bound.claim.mock.results[0]!.value;
  if ("kind" in claims) throw new Error("Unexpected refused claim");
  const selected = claims[0]!;
  const before = row.correction ? { ...f.saved, before: f.saved, after: zero, parentDocumentId: (await state(base.dutyId)).document_id, parentExternalId: f.parent, reason } : f.saved;
  expect(selected).toEqual({ dutyId: f.dutyId, documentId: expect.any(String), requestId: expect.any(String), token: expect.any(String), generation,
    leaseUntil: expect.any(String), identity: expectedIdentity, facts: { ...before, seller: claimedSeller, sellerRevision: claimedRevision, sellerMode: "frozen" }, action: readback ? "readback" : "create",
    correction: row.correction ? { before: f.saved, after: zero, reason } : null });
  const workerClaim = { ...selected, attemptCount: generation };
  if (readback) {
    expect(io).toEqual(["read"]); expect(provider.read).toHaveBeenCalledExactlyOnceWith(expectedIdentity);
    expect(readLocalPayment).not.toHaveBeenCalled(); expect(money.read).not.toHaveBeenCalled(); expect(bound.preflight).not.toHaveBeenCalled();
  } else {
    expect(readLocalPayment).toHaveBeenCalledExactlyOnceWith(workerClaim);
    if (localBlocked || row.arm === "stale_local") expect(io).toEqual(["local"]);
    else {
      expect(money.read).toHaveBeenCalledExactlyOnceWith({ intentRef: f.saved.payment.intentRef, providerRef: "money-provider", providerPaymentRef: "remote-payment", expectedMoney: { amountMinor: 900, currency: "XXX" } });
      expect(io).toEqual(freshBlocked || freshUnavailable || row.arm === "stale_fresh" ? ["local", "money"] : ["local", "money", row.correction ? "correct" : "issue"]);
    }
  }
  if (!readback) {
    const variants: Evidence[] = [row.local ?? "unavailable", ...(!localBlocked && row.arm !== "stale_local" ? [row.fresh ?? "succeeded" as Evidence] : [])];
    for (const [index, variant] of variants.entries()) {
      const observed = evidence(variant);
      const common = { claim: workerClaim, amountMinor: observed.kind === "observed" ? observed.amountMinor : null, currency: observed.kind === "observed" ? observed.currency : null };
      expect(bound.preflight.mock.calls[index]).toEqual([observed.kind === "absent" ? { ...common, status: "absent", evidence: observed.evidence }
        : { ...common, status: observed.kind === "observed" ? observed.status : "unavailable", proof: observed.kind === "observed" ? proof : null }]);
      expect(await bound.preflight.mock.results[index]!.value).toEqual({ kind: (index === 0 && row.arm === "stale_local") || (index === 1 && row.arm === "stale_fresh") ? "stale"
        : variant === "amount_mismatch" || variant === "currency_mismatch" ? "mismatch" : variant === "failed" || variant === "pending" ? "blocked"
          : observed.kind !== "observed" ? "unavailable" : "ready" });
    }
    expect(bound.preflight).toHaveBeenCalledTimes(variants.length);
  }
  const dispatched = io.includes("issue") || io.includes("correct");
  if (dispatched) {
    if (row.correction) expect(provider.correct).toHaveBeenCalledExactlyOnceWith({ identity: expectedIdentity, before: { ...f.saved, seller: claimedSeller, sellerRevision: claimedRevision, sellerMode: "frozen" }, after: zero, reason, recoveryLookupRequired: generation > 1 });
    else expect(provider.issue).toHaveBeenCalledExactlyOnceWith({ identity: expectedIdentity, facts: { ...f.saved, seller: claimedSeller, sellerRevision: claimedRevision, sellerMode: "frozen" }, recoveryLookupRequired: generation > 1 });
  }
  if (!dispatched || row.correction) expect(provider.issue).not.toHaveBeenCalled();
  if (!dispatched || !row.correction) expect(provider.correct).not.toHaveBeenCalled();
  if (!readback) expect(provider.read).not.toHaveBeenCalled();
  const failure = localBlocked || freshBlocked || row.arm === "blocked" ? "blocked"
    : freshUnavailable || row.arm === "retryable" || row.arm === "stale_fail" || row.arm === "reversal_retryable" ? "retryable"
      : row.arm === "unsupported" ? "unsupported" : row.arm === "absent" || row.arm === "reversal_absent" ? "absent" : "unknown";
  const voided = row.arm === "reversal_retryable" || row.arm === "reversal_absent";
  if (success || row.arm === "stale_local" || row.arm === "stale_fresh" || row.arm === "stale_finish") expect(bound.fail).not.toHaveBeenCalled();
  else {
    expect(bound.fail).toHaveBeenCalledExactlyOnceWith({ claim: workerClaim, retrySeconds: generation * 300,
      ...(failure === "absent" ? { kind: "absent", evidence: await provider.read.mock.results[0]!.value }
        : { kind: failure, proof: null, ...(failure === "retryable" ? { phase: "before_send" } : {}) }) });
    expect(await bound.fail.mock.results[0]!.value).toEqual({ kind: row.arm === "stale_fail" ? "stale" : voided ? "voided" : "recorded" });
  }
  if (success || row.arm === "finish_unsupported" || row.arm === "stale_finish") {
    const remote = await (readback ? provider.read : row.correction ? provider.correct : provider.issue).mock.results[0]!.value;
    expect(bound.finish).toHaveBeenCalledExactlyOnceWith({ claim: workerClaim, result: remote });
    expect(await bound.finish.mock.results[0]!.value).toMatchObject({ kind: success ? "issued" : row.arm === "stale_finish" ? "stale" : "unsupported" });
  } else expect(bound.finish).not.toHaveBeenCalled();
  const recordedEvidence = failure === "absent" ? { kind: "authoritative_absence", providerCreateIdentity: expectedIdentity.providerCreateIdentity,
    proof: (await provider.read.mock.results[0]!.value as Extract<Awaited<ReturnType<InvoiceProviderPort["read"]>>, { kind: "absent" }>).evidence }
    : { proof: null, ...(failure === "retryable" ? { phase: "before_send" } : {}) };
  const persistedProof = { kind: readback ? "readback_found" : "issued", externalId: positive(expectedIdentity).providerDocumentRef,
    providerCreateIdentity: expectedIdentity.providerCreateIdentity, parentExternalId: f.parent, proof };
  const lastResult = success ? { externalId: positive(expectedIdentity).providerDocumentRef, number: positive(expectedIdentity).providerDocumentNumber, proof: persistedProof }
    : stale ? { action: "create", ...(row.arm === "stale_local" ? {} : { preflight: row.arm === "stale_fresh" ? "unavailable" : "ready" }) }
      : { kind: failure, evidence: recordedEvidence };
  const savedState = await state(f.dutyId);
  expect(savedState).toMatchObject({ id: f.dutyId, order_id: f.orderId, original_key: f.requestKey, provider: providerRef, generation,
    document_id: selected.documentId, request_id: selected.requestId, parent_duty_id: f.baseDutyId,
    status: success ? "issued" : stale ? "processing" : voided ? "voided" : failure === "retryable" || failure === "absent" ? "ready" : failure,
    claim_token: stale ? selected.token : null, lease_until: stale ? expect.any(Date) : null,
    last_result: lastResult, reversal, request_status: success ? "succeeded" : stale ? "processing" : voided ? "discarded" : "failed",
    attempts: generation, request_token: stale ? selected.token : null, request_available: "infinity",
    document_status: success ? row.arm === "reversal_found" ? "correction_requested" : "issued" : voided ? "voided" : row.correction ? "draft" : "issue_requested",
    provider_reference: success ? positive(expectedIdentity).providerDocumentRef : null, total_gross_minor: row.correction ? "-900" : "900",
    correction_of_document_id: row.correction ? (await state(base.dutyId)).document_id : null,
  });
  const positions = (await h.pool.query("SELECT description,quantity,unit_gross_minor,total_gross_minor,tax_rate_bps FROM public.accounting_document_positions WHERE document_id=$1 ORDER BY position_ordinal", [selected.documentId])).rows;
  expect(positions).toEqual(f.saved.lines.map(line => ({ description: line.description, quantity: line.quantity,
    unit_gross_minor: String((row.correction ? -1 : 1) * line.unitGrossMinor), total_gross_minor: String((row.correction ? -1 : 1) * line.totalGrossMinor), tax_rate_bps: line.taxRateBps })));
  const docs = (await h.pool.query("SELECT id FROM public.accounting_documents WHERE order_id=$1", [f.orderId])).rows;
  expect(docs).toHaveLength(row.correction || row.arm === "reversal_found" ? 2 : 1);
  if (row.correction) expect(await state(base.dutyId)).toMatchObject({ status: "issued", document_status: success ? "corrected" : "correction_requested", generation: 1 });
  if (row.arm === "reversal_found") {
    const child = (await h.pool.query("SELECT id FROM public.invoicing_duties WHERE parent_duty_id=$1", [f.dutyId])).rows[0]!.id;
    expect(await state(child)).toMatchObject({ status: "ready", generation: 0, original_key: reversal!.key, request_status: "pending", document_status: "draft" });
  }
});

// PART B: actual package store against the complete approved native SQL chain.
const sellerRows = ["lock contention", "paid replay", "handoff", "capture conflict", "reversal conflict", "frozen", "retry", "legacy", "bare claim", "correction", "unknown", "unsupported", "missing seller", "rollback", "race"] as const;
it.each(sellerRows)("P7 installed seller store: %s", async arm => {
  const base = await seed();
  const selected = { limit: 1, visibilitySeconds: 97, providerRef, orderId: base.orderId };
  const revisionState = async (dutyId = base.dutyId) => (await h.pool.query("SELECT revision_ref,seller_facts,capture_generation FROM public.invoicing_seller_revisions WHERE duty_id=$1", [dutyId])).rows;
  if (arm === "lock contention") {
    const snapshot = async () => ({ duty: await state(base.dutyId), revisions: await revisionState(),
      receipts: (await h.pool.query("SELECT * FROM public.invoicing_effect_receipts WHERE duty_id=$1 ORDER BY receipt_key", [base.dutyId])).rows });
    const before = await snapshot(), locker = await h.pool.connect();
    const handoff = { ...base.capture, requestKey: `busy-handoff:${base.orderId}`, sourceKind: "handoff" as const,
      sourceId: randomUUID(), evidence: { shipmentId: randomUUID(), handedOverAt: base.capture.occurredAt } };
    try {
      for (const lock of ["row", "advisory"] as const) {
        await locker.query("BEGIN");
        if (lock === "row") await locker.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [base.orderId]);
        else await locker.query("SELECT pg_advisory_xact_lock(hashtextextended('invoicing:'||$1::text,0))", [base.orderId]);
        for (const input of [base.capture, handoff]) await expect(store.captureDuty(input)).rejects.toMatchObject({ code: "55P03" });
        if (lock === "advisory") await expect(store.requestReversal({ requestKey: `busy-reversal:${base.orderId}`, orderId: base.orderId, reason, proof }))
          .rejects.toMatchObject({ code: "55P03", message: "invoicing_capture_busy" });
        expect(await snapshot()).toEqual(before);
        await locker.query("ROLLBACK");
      }
    } finally { await locker.query("ROLLBACK"); locker.release(); }
    for (const input of [base.capture, handoff]) expect(await store.captureDuty(input)).toEqual({ dutyId: base.dutyId, status: "ready" });
    expect(await state(base.dutyId)).toEqual(before.duty);
    expect(await revisionState()).toEqual(before.revisions);
    expect((await h.pool.query("SELECT count(*)::int count FROM public.invoicing_duties WHERE order_id=$1", [base.orderId])).rows).toEqual([{ count: 1 }]);
    const reversal = { requestKey: `busy-reversal:${base.orderId}`, orderId: base.orderId, reason, proof };
    expect(await store.requestReversal(reversal)).toEqual({ kind: "voided", replayed: false });
    expect(await store.requestReversal(reversal)).toEqual({ kind: "voided", replayed: true });
    expect(await state(base.dutyId)).toMatchObject({ status: "voided", document_status: "voided" });
    return;
  }
  if (arm === "paid replay" || arm === "handoff" || arm === "capture conflict") {
    const before = await state(base.dutyId);
    const input = arm === "handoff" ? { ...base.capture, sourceKind: "handoff" as const, sourceId: randomUUID(), requestKey: `handoff:${base.orderId}`, evidence: { shipmentId: randomUUID(), handedOverAt: "2026-10-17T06:05:04Z" } }
      : arm === "capture conflict" ? { ...base.capture, evidence: { ...base.capture.evidence, amountMinor: 901 } } : base.capture;
    expect(await store.captureDuty(input)).toEqual(arm === "capture conflict" ? { kind: "conflict", code: "identity_mismatch" } : { dutyId: base.dutyId, status: "ready" });
    expect(await state(base.dutyId)).toEqual(before);
    expect(await revisionState()).toEqual([{ revision_ref: null, seller_facts: null, capture_generation: null }]);
    const receipts = (await h.pool.query("SELECT payload FROM public.invoicing_effect_receipts WHERE receipt_key=$1", [`source:${input.sourceKind}:${input.sourceId}`])).rows;
    expect(receipts).toEqual([{ payload: { sourceKind: input.sourceKind, sourceId: input.sourceId, orderId: base.orderId,
      evidence: arm === "capture conflict" ? base.capture.evidence : input.evidence, occurredAt: "2026-10-18T09:08:07.000000Z" } }]);
    return;
  }
  if (arm === "reversal conflict") {
    const input = { requestKey: `reversal-conflict:${base.orderId}`, orderId: base.orderId, reason, proof };
    expect(await store.requestReversal(input)).toEqual({ kind: "voided", replayed: false });
    const before = await state(base.dutyId);
    expect(await store.requestReversal({ ...input, proof: { ...proof, evidenceRef: "different-evidence" } })).toEqual({ kind: "conflict", code: "identity_mismatch" });
    expect(await state(base.dutyId)).toEqual(before);
    expect((await h.pool.query("SELECT payload FROM public.invoicing_effect_receipts WHERE receipt_key=$1", [`reversal-key:${input.requestKey}`])).rows)
      .toEqual([{ payload: { key: input.requestKey, reason, evidence: { ...proof, reason, sellerPolicyVersion: "invoicing.seller.v1" } } }]);
    return;
  }
  if (arm === "unknown" || arm === "unsupported" || arm === "missing seller") {
    const before = await state(base.dutyId);
    const result = arm === "unknown" ? { kind: "unknown", code: "unknown" } as const : { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } as const;
    const refused = createPostgresInvoiceStore(executor, arm === "missing seller" ? undefined : { seller: { read: async () => result } });
    expect(await refused.claim(selected)).toEqual({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false });
    expect(await state(base.dutyId)).toEqual(before);
    expect(await revisionState()).toEqual([{ revision_ref: null, seller_facts: null, capture_generation: null }]);
    return;
  }
  if (arm === "rollback") {
    const before = await state(base.dutyId), db = await h.pool.connect();
    try {
      await db.query("BEGIN");
      const tx = createPostgresInvoiceStore({ query: (sql, values) => db.query(sql, values) }, { seller: sellerBinding });
      expect(await tx.claim(selected)).toMatchObject([{ generation: 1, facts: { seller, sellerRevision, sellerMode: "frozen" } }]);
      await db.query("ROLLBACK");
    } finally { await db.query("ROLLBACK"); db.release(); }
    expect(await state(base.dutyId)).toEqual(before);
    expect(await revisionState()).toEqual([{ revision_ref: null, seller_facts: null, capture_generation: null }]);
    return;
  }
  if (arm === "legacy") {
    await h.pool.query("DELETE FROM public.invoicing_seller_revisions WHERE duty_id=$1", [base.dutyId]);
    await h.pool.query("UPDATE public.invoicing_duties SET seller_policy_version=NULL WHERE id=$1", [base.dutyId]);
  }
  if (arm === "bare claim") {
    const raw = (await h.pool.query("SELECT public.invoicing_claim_duties(1,97,$1,$2) result", [providerRef, base.orderId])).rows[0].result;
    expect(raw).toMatchObject([{ generation: 1 }]);
    await h.pool.query("UPDATE public.invoicing_duties SET lease_until=now()-interval '1 second' WHERE id=$1", [base.dutyId]);
  }
  const target = arm === "correction" ? await correction(base) : base;
  const changed = createPostgresInvoiceStore(executor, { seller: { read: async () => ({ kind: "found", seller: { ...seller, name: "Later seller" }, revisionRef: "later-revision" }) } });
  const batch = arm === "race" ? (await Promise.all([store.claim(selected), changed.claim(selected)])).flat() : await store.claim(selected);
  if (!Array.isArray(batch) || batch.length !== 1) throw new Error(`Expected one ${arm} claim`);
  const first = batch[0]!;
  if ("kind" in first) throw new Error("Seller claim refused");
  const mode = arm === "legacy" || arm === "bare claim" ? "legacy_fallback" : "frozen";
  expect(first).toMatchObject({ dutyId: target.dutyId, generation: arm === "bare claim" ? 2 : 1,
    facts: { seller: arm === "race" ? first.facts.seller : seller, sellerRevision: arm === "race" ? first.facts.sellerRevision : sellerRevision, sellerMode: mode } });
  expect(await state(target.dutyId)).toMatchObject({ status: "processing", generation: first.generation, claim_token: first.token });
  expect(await revisionState(target.dutyId)).toEqual(arm === "legacy" ? [] : arm === "bare claim" ? [{ revision_ref: null, seller_facts: null, capture_generation: null }]
    : [{ revision_ref: first.facts.sellerRevision, seller_facts: first.facts.seller, capture_generation: first.generation }]);
  if (arm === "retry" || arm === "legacy" || arm === "bare claim") {
    await h.pool.query("UPDATE public.invoicing_duties SET lease_until=now()-interval '1 second' WHERE id=$1", [target.dutyId]);
    const retry = await changed.claim(selected);
    expect(retry).toMatchObject([{ generation: first.generation + 1, facts: { sellerMode: mode,
      seller: mode === "frozen" ? seller : { ...seller, name: "Later seller" }, sellerRevision: mode === "frozen" ? sellerRevision : "later-revision" } }]);
    expect(await state(target.dutyId)).toMatchObject({ generation: first.generation + 1, status: "processing" });
    expect(await revisionState(target.dutyId)).toEqual(arm === "legacy" ? [] : arm === "bare claim" ? [{ revision_ref: null, seller_facts: null, capture_generation: null }]
      : [{ revision_ref: sellerRevision, seller_facts: seller, capture_generation: 1 }]);
  }
});
