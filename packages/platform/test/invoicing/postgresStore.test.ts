import { expect, it, vi } from "vitest";
import { createPostgresInvoiceStore, INVOICING_MIGRATIONS, runNativeInvoiceIssueJob } from "../../src/invoicing/index.js";
import type { InvoiceFacts, InvoiceStorePort } from "../../src/invoicing/contracts/index.js";

type Claim = Parameters<InvoiceStorePort["preflight"]>[0]["claim"];
const facts: InvoiceFacts = {
  factRevision: "facts-a", policyVersion: "host-v1", refs: { orderId: "order-a", orderRef: "ORDER/A", invoiceRef: "INVOICE/A" },
  dates: { issueDate: "2026-10-22", sellDate: "2026-10-21", handedOverAt: null, paymentCompletedAt: null },
  documentKind: "host-document", clearanceRequired: false, currency: "XXX",
  buyer: { name: "Saved buyer", email: null, taxIdentifier: null, companyName: null, address: null },
  payment: { intentRef: "intent-a", providerRef: null, providerPaymentRef: null, amountMinor: 900, currency: "XXX", localSettlementState: "matched" }, orderMoney: null,
  lines: [{ description: "Saved item", quantity: 1, unitNetMinor: 750, unitGrossMinor: 900, totalNetMinor: 750, totalTaxMinor: 150, totalGrossMinor: 900, taxRateBps: 2000, positionKind: "item", catalogTotalGrossMinor: null, discountAllocatedMinor: null, shippingGrossMinor: null, shippingDiscountMinor: null }],
  totalNetMinor: 750, totalTaxMinor: 150, totalGrossMinor: 900, chargedTotalGrossMinor: 900,
};
const raw = { id: "duty-a", document_id: "document-a", request_id: "request-a", claim_token: "token-a", generation: 2, lease_until: "2026-10-22T12:00:00Z", parent_duty_id: null, provider: "host-a", original_key: "  Exact key  ", providerCreateIdentity: "invoicing:duty-a", facts, last_result: { action: "readback" } };
it("maps the native lease, exact identity and facts, split transactions, preflight and fenced results without a driver dependency", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response: { kind: "ready" } }] }));
  const store = createPostgresInvoiceStore({ query });
  query.mockResolvedValueOnce({ rows: [{ facts }] }).mockResolvedValueOnce({ rows: [{ response: [raw] }] });
  const claims = await store.claim({ limit: 1, visibilitySeconds: 300, providerRef: "host-a", orderId: "order-a" });
  expect(Array.isArray(claims)).toBe(true); const claim = (claims as readonly Claim[])[0]!;
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("invoicing_claim_duties($1,$2,$3,$4)"), [1,300,"host-a","order-a"]);
  expect(claim).toMatchObject({ dutyId: "duty-a", documentId: "document-a", token: "token-a", generation: 2, action: "readback", facts, correction: null, identity: { requestKey: "  Exact key  ", providerCreateIdentity: "invoicing:duty-a", factRevision: "facts-a", operation: "issue" } });
  expect(await store.preflight({ claim, status: "succeeded", amountMinor: 900, currency: "XXX", proof: null })).toEqual({ kind: "ready" });
  expect(query.mock.calls.at(-1)?.[1]).toEqual(["duty-a","token-a",2,{ kind: "observed", outcome: "captured", amountMinor: 900, currency: "XXX", proof: null }]);
  query.mockResolvedValueOnce({ rows: [{ response: { status: "owed", kind: "retryable" } }] });
  expect(await store.prepareFacts({ dutyId: "duty-a", token: "fact-token" })).toEqual({ status: "owed", code: "retryable" });
  query.mockResolvedValueOnce({ rows: [{ response: { status: "stale" } }] });
  expect(await store.finishFacts({ dutyId: "duty-a", token: "fact-token", result: { status: "owed", code: "retryable" } })).toEqual({dutyId:"duty-a",status:"stale"});
  expect(query.mock.calls.at(-1)?.[1]).toEqual(["duty-a","fact-token",{ status: "owed", code: "retryable", kind: "retryable" }]);
  query.mockResolvedValueOnce({ rows: [{ response: { kind: "issued", replayed: false } }] });
  const proof = { evidenceRef: "evidence-a", fingerprint: "a".repeat(64), observedAt: "2026-10-22T12:00:00Z" };
  expect(await store.finish({ claim, result: { kind: "found", identity: claim.identity, providerDocumentRef: "remote-a", providerDocumentNumber: null, proof } })).toEqual({ kind: "issued", replayed: false });
  expect(query.mock.calls.at(-1)?.[1]).toEqual(["duty-a","token-a",2,"remote-a",null,{kind:"readback_found",externalId:"remote-a",providerCreateIdentity:"invoicing:duty-a",parentExternalId:null,proof}]);
  query.mockResolvedValueOnce({ rows: [{ response: { kind: "unknown" } }] });
  expect(await store.fail({ claim, kind: "unknown", proof: null, retrySeconds: 0 })).toEqual({ kind: "recorded" });
  expect(INVOICING_MIGRATIONS.native.correctionStorage).toBe("child_document");
  expect(INVOICING_MIGRATIONS.managed.correctionStorage).toBe("base_row");
  expect(INVOICING_MIGRATIONS.native.units).toHaveLength(6);
  expect(query.mock.calls.flatMap(c => c[0])).not.toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
});
it("refuses missing host facts, unsafe money and mismatched recovery before writes; leaves duty reads and local-only requests distinct", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [] }));
  const store = createPostgresInvoiceStore({ query });
  for (const invalid of [null, {}, { ...facts, payment: { ...facts.payment, currency: null } }, { ...facts, factRevision: 4 }, { ...facts, lines: [null] }, { ...facts, documentKind: "" }, { ...facts, lines: [{ ...facts.lines[0], taxRateBps: 50000 }] }, { ...facts, totalTaxMinor: 151 }]) {
    expect(await store.installFacts({ dutyId: "owed-a", facts: invalid as InvoiceFacts })).toMatchObject({ kind: "unsupported", effectMayHaveSucceeded: false });
  }
  const claim = { identity: { providerRef: "host-a", requestKey: "key-a" } } as Claim;
  expect(await store.finish({ claim, result: { kind: "found", identity: { ...claim.identity, providerRef: "host-b" }, providerDocumentRef: "foreign", providerDocumentNumber: null, proof: { evidenceRef: "proof", fingerprint: "hash", observedAt: "date" } } })).toMatchObject({ kind: "unsupported" });
  expect(await store.claimDeliveries({ limit: 1, visibilitySeconds: 30, requireClearance: true })).toMatchObject({ kind: "unsupported" });
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ rows: [{ facts: {} }] });
  expect(await store.claim({limit:1,visibilitySeconds:30,providerRef:"host-a",orderId:"order-a"})).toMatchObject({kind:"unsupported"});
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).not.toContain("invoicing_claim_duties");
  query.mockResolvedValueOnce({ rows: [{ response: { orderId: "order-a", captureFaults: [], duties: [] } }] });
  expect(await store.readDuties("order-a")).toEqual({ orderId: "order-a", captureFaults: [], duties: [] });
  query.mockResolvedValueOnce({ rows: [{ response: { document: { id: "local-a", status: "issue_requested" }, replayed: true } }] }).mockResolvedValueOnce({ rows: [{ document_ref: "LOCAL/A" }] });
  expect(await store.requestLocalDocument({ requestKey: " exact local key ", orderId: "order-a", providerRef: "local-a" })).toEqual({ kind: "requested", documentId: "local-a", invoiceRef: "LOCAL/A", replayed: true, status: "issue_requested" });
  expect(query.mock.calls.at(-2)?.[1]).toEqual([" exact local key ","order-a","local-a"]);
});

const proof = { evidenceRef: "money-a", fingerprint: "a".repeat(64), observedAt: "2026-10-22T12:00:00Z" };
it("binds capture duty and fact installation to the exact native SQL argument order", async () => {
  const dutyId = "10000000-0000-4000-8000-000000000001";
  const sourceId = "20000000-0000-4000-8000-000000000002";
  const orderId = "30000000-0000-4000-8000-000000000003";
  const evidence = { settlementIntentId: sourceId, amountMinor: 900, currency: "XXX" };
  const occurredAt = "2026-10-21T12:34:56Z";
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { dutyId, status: "owed" } }] }));
  const store = createPostgresInvoiceStore({ query });
  expect(await store.captureDuty({ requestKey: " exact capture key ", sourceKind: "paid", sourceId, orderId, evidence, occurredAt })).toEqual({ dutyId, status: "owed" });
  expect(query).toHaveBeenLastCalledWith(
    "SELECT public.invoicing_capture_duty($1,$2,$3,$4,$5,$6) AS response",
    [" exact capture key ", "paid", sourceId, orderId, evidence, occurredAt],
  );
  expect(await store.installFacts({ dutyId, facts })).toEqual({ dutyId, status: "owed" });
  expect(query).toHaveBeenLastCalledWith(
    "SELECT public.invoicing_install_facts($1,$2,$3) AS response", [dutyId, facts, "facts-a"],
  );
  expect(query).toHaveBeenCalledTimes(2);
});
it.each(["missing", "voided", "pending_readback", "correction_requested", "unsupported"] as const)(
  "preserves the native reversal %s result and binds key/order/reason/proof in order", async kind => {
    const response = { kind, dutyId: "10000000-0000-4000-8000-000000000001", replayed: true };
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response }] }));
    const store = createPostgresInvoiceStore({ query });
    const orderId = "30000000-0000-4000-8000-000000000003";
    expect(await store.requestReversal({ requestKey: " exact reversal key ", orderId, reason: "order_refunded", proof }))
      .toEqual({ ...response, kind: kind === "unsupported" ? "unsupported_recorded" : kind });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      "SELECT public.invoicing_request_reversal($1,$2,$3,$4) AS response",
      [" exact reversal key ", orderId, "order_refunded", proof],
    );
  },
);
it.each(["unknown", "blocked", "unsupported", "retryable", "absent"] as const)(
  "binds native fail %s to duty/token/generation/kind/evidence/delay", async kind => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { kind: "unknown" } }] }));
    const store = createPostgresInvoiceStore({ query });
    const { claim } = issueFixture();
    const absence = { exact: true as const, complete: true as const, scope: claim.identity, ...proof };
    const result = await store.fail(kind === "absent"
      ? { claim, kind, retrySeconds: 73, evidence: { kind, identity: claim.identity, evidence: absence } }
      : kind === "retryable" ? { claim, kind, phase: "before_send", proof, retrySeconds: 73 }
        : { claim, kind, proof, retrySeconds: 73 });
    expect(result).toEqual({ kind: "recorded" });
    const evidence = kind === "absent"
      ? { kind: "authoritative_absence", providerCreateIdentity: "invoicing:duty-a", proof: absence }
      : kind === "retryable" ? { phase: "before_send", proof } : { proof };
    expect(query).toHaveBeenCalledExactlyOnceWith(
      "SELECT public.invoicing_fail_duty($1,$2,$3,$4,$5,$6) AS response",
      ["duty-a", "token-a", 4, kind, evidence, 73],
    );
  },
);
function issueFixture(action: "create" | "readback" = "create") {
  const claim: Claim = { dutyId: "duty-a", documentId: "doc-a", requestId: "req-a", token: "token-a", generation: 4,
    leaseUntil: "2026-10-22T12:00:00Z", facts, action, correction: null,
    identity: { providerRef: "host-a", requestKey: "key-a", providerCreateIdentity: "invoicing:duty-a", factRevision: "facts-a",
      orderRef: "ORDER/A", invoiceRef: "INVOICE/A", operation: "issue", correctionRef: null, parentProviderDocumentRef: null } };
  const issued = { kind: "issued" as const, identity: claim.identity, providerDocumentRef: "remote-a", providerDocumentNumber: null, proof, replayed: false };
  const store = { claim: vi.fn(async () => [claim]), preflight: vi.fn<InvoiceStorePort["preflight"]>(async () => ({ kind: "ready" })),
    finish: vi.fn<InvoiceStorePort["finish"]>(async () => ({ kind: "issued", replayed: false })),
    fail: vi.fn<InvoiceStorePort["fail"]>(async () => ({ kind: "recorded" })) };
  const provider = { issue: vi.fn(async () => issued), correct: vi.fn(async () => issued),
    read: vi.fn(async (): Promise<import("../../src/invoicing/contracts/index.js").InvoiceReadbackResult> => ({ ...issued, kind: "found" })) };
  const money = { read: vi.fn(async () => ({ kind: "observed" as const, status: "succeeded" as const, amountMinor: 900, currency: "XXX", proof })) };
  const readLocalPayment = vi.fn(async () => ({ kind: "unavailable" as const, code: "money_unavailable" as const }));
  return { claim, store, provider, money, readLocalPayment, run: () => runNativeInvoiceIssueJob({ store, provider, money, readLocalPayment, providerRef: "host-a", orderId: "order-a" }) };
}
it("native issue continues after unavailable local evidence, freshly checks money and uses generation as attemptCount", async () => {
  const f = issueFixture(); f.store.preflight.mockResolvedValueOnce({ kind: "unavailable" });
  expect(await f.run()).toEqual({ checked: 1, updated: 1, failures: 0, ok: true });
  expect(f.store.preflight.mock.calls.map(([v]) => v.status)).toEqual(["unavailable", "succeeded"]);
  expect(f.provider.issue).toHaveBeenCalledWith(expect.objectContaining({ recoveryLookupRequired: true, facts }));
  expect(f.store.fail).not.toHaveBeenCalled(); expect(f.provider.read).not.toHaveBeenCalled();
  expect(f.money.read).toHaveBeenCalledOnce();
});
it.each(["blocked", "mismatch", "unavailable"] as const)("native fresh %s settles the claim before returning without dispatch", async kind => {
  const f = issueFixture(); f.store.preflight.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce({ kind });
  expect(await f.run()).toMatchObject({ updated: 0, failures: 1 });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(kind === "unavailable"
    ? { kind: "retryable", phase: "before_send", claim: expect.objectContaining({ generation: 4, attemptCount: 4 }) }
    : { kind: "blocked" }));
  expect(f.provider.issue).not.toHaveBeenCalled();
});
it.each(["local", "fresh", "finish"] as const)("native stale %s is a claim fence: zero updates and no failure write", async phase => {
  const f = issueFixture();
  if (phase === "local") f.store.preflight.mockResolvedValueOnce({ kind: "stale" });
  if (phase === "fresh") f.store.preflight.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce({ kind: "stale" });
  if (phase === "finish") f.store.finish.mockResolvedValueOnce({ kind: "stale" });
  expect(await f.run()).toMatchObject({ updated: 0, failures: 1 }); expect(f.store.fail).not.toHaveBeenCalled();
});
it.each(["found", "absent", "unknown"] as const)("native readback %s never creates or reads payment", async kind => {
  const f = issueFixture("readback");
  if (kind === "absent") f.provider.read.mockResolvedValue({ kind, identity: f.claim.identity, evidence: { ...proof, exact: true, complete: true, scope: f.claim.identity } });
  if (kind === "unknown") f.provider.read.mockResolvedValue({ kind, identity: f.claim.identity, code: "unknown" });
  expect(await f.run()).toMatchObject({ updated: kind === "found" ? 1 : 0 });
  expect(f.provider.issue).not.toHaveBeenCalled(); expect(f.provider.correct).not.toHaveBeenCalled();
  expect(f.store.preflight).not.toHaveBeenCalled(); expect(f.money.read).not.toHaveBeenCalled(); expect(f.readLocalPayment).not.toHaveBeenCalled();
  if (kind !== "found") expect(f.store.fail).toHaveBeenCalledWith(expect.objectContaining({ kind }));
});

it("preserves installed-facts replay states, voided failures and post-write reversal refusals; nullable money is unavailable", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response: { kind: "unavailable" } }] }));
  const store = createPostgresInvoiceStore({ query }), claim = issueFixture().claim;
  for (const status of ["ready", "processing", "issued", "voided"]) {
    query.mockResolvedValueOnce({ rows: [{ response: { dutyId: "duty-a", status, replayed: true } }] });
    expect(await store.installFacts({ dutyId: "duty-a", facts })).toEqual({ dutyId: "duty-a", status, replayed: true });
  }
  expect(await store.preflight({ claim, status: "succeeded", amountMinor: null, currency: "XXX", proof })).toEqual({ kind: "unavailable" });
  expect(query.mock.calls.at(-1)?.[1]).toEqual(["duty-a", "token-a", 4, { kind: "unavailable", outcome: "captured", amountMinor: null, currency: "XXX", proof }]);
  query.mockResolvedValueOnce({ rows: [{ response: { kind: "voided" } }] });
  expect(await store.fail({ claim, kind: "retryable", phase: "before_send", proof: null, retrySeconds: 0 })).toEqual({ kind: "voided" });
  query.mockResolvedValueOnce({ rows: [{ response: { kind: "unsupported" } }] });
  expect(await store.requestReversal({ requestKey: "reversal-a", orderId: "order-a", reason: "order_refunded", proof })).toEqual({ kind: "unsupported_recorded" });
});

it("discovers captured duties before facts exist using a bounded read-only query", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ dutyId: "owed-a", orderId: "order-a" }] }));
  expect(await createPostgresInvoiceStore({ query }).discoverDuties(7)).toEqual([{ dutyId: "owed-a", orderId: "order-a" }]);
  expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("NOT EXISTS (SELECT 1 FROM public.invoicing_fact_revisions"), [7, null]);
  expect(query.mock.calls[0]?.[0]).toContain("LIMIT least(greatest(coalesce($1::integer,10),1),100)");
  expect(query.mock.calls[0]?.[0]).not.toMatch(/FOR UPDATE|INSERT|UPDATE|DELETE/);
  expect(await createPostgresInvoiceStore({ query }).discoverDuties(7, "owed-a")).toEqual([{ dutyId: "owed-a", orderId: "order-a" }]);
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("($2::uuid IS NULL OR d.id>$2::uuid)"), [7, "owed-a"]);
  expect(query.mock.calls[1]?.[0]).toContain("ORDER BY d.id LIMIT");
});
