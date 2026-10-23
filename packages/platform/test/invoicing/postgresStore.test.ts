import { expect, it, vi } from "vitest";
import { createPostgresInvoiceStore, INVOICING_MIGRATIONS, runNativeInvoiceIssueJob } from "../../src/invoicing/index.js";
import type { InvoiceFacts, InvoiceProviderPort, InvoiceStorePort } from "../../src/invoicing/contracts/index.js";

const selectedSeller = { name: "Seller", address: { line1: "Example", postalCode: "00000", city: "Example" }, taxIdentifier: { scheme: "host", value: "synthetic" }, bankAccount: null, routingRef: null };
const seller = { read: async () => ({ kind: "found" as const, seller: selectedSeller, revisionRef: "seller-v1" }) };
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
const raw = { id: "duty-a", document_id: "document-a", request_id: "request-a", claim_token: "token-a", generation: 2, lease_until: "2026-10-22T12:00:00Z", parent_duty_id: null, provider: "host-a", original_key: "  Exact key  ", providerCreateIdentity: "invoicing:duty-a", seller: selectedSeller, sellerRevision: "seller-v1", sellerMode: "frozen", facts, last_result: { action: "readback" } };
it("maps the native lease, exact identity and facts, split transactions, preflight and fenced results without a driver dependency", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response: { kind: "ready" } }] }));
  const store = createPostgresInvoiceStore({ query }, { seller });
  query.mockResolvedValueOnce({ rows: [{ facts }] }).mockResolvedValueOnce({ rows: [{ response: [raw] }] });
  const claims = await store.claim({ limit: 1, visibilitySeconds: 300, providerRef: "host-a", orderId: "order-a" });
  expect(Array.isArray(claims)).toBe(true); const claim = (claims as readonly Claim[])[0]!;
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("invoicing_claim_with_seller($1,$2,$3,$4,$5,$6)"), [1,300,"host-a",selectedSeller,"seller-v1","order-a"]);
  expect(claim).toMatchObject({ dutyId: "duty-a", documentId: "document-a", token: "token-a", generation: 2, action: "readback", facts, correction: null });
  expect(claim.identity).toEqual({ providerRef: "host-a", requestKey: "  Exact key  ", providerCreateIdentity: "invoicing:duty-a",
    factRevision: "facts-a", orderRef: "ORDER/A", invoiceRef: "INVOICE/A", operation: "issue", correctionRef: null, parentProviderDocumentRef: null });
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
  expect(INVOICING_MIGRATIONS.native.units).toHaveLength(7);
  expect(query.mock.calls.flatMap(c => c[0])).not.toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
});
it("refuses missing host facts, unsafe money and mismatched recovery before writes; leaves duty reads and local-only requests distinct", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [] }));
  const store = createPostgresInvoiceStore({ query }, { seller });
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
  const store = createPostgresInvoiceStore({ query }, { seller });
  expect(await store.captureDuty({ requestKey: " exact capture key ", sourceKind: "paid", sourceId, orderId, evidence, occurredAt })).toEqual({ dutyId, status: "owed" });
  expect(query).toHaveBeenLastCalledWith(
    "SELECT public.invoicing_request_with_seller_policy($1,$2,$3,$4,$5,$6) AS response",
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
    const store = createPostgresInvoiceStore({ query }, { seller });
    const orderId = "30000000-0000-4000-8000-000000000003";
    expect(await store.requestReversal({ requestKey: " exact reversal key ", orderId, reason: "order_refunded", proof }))
      .toEqual({ ...response, kind: kind === "unsupported" ? "unsupported_recorded" : kind });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      "SELECT public.invoicing_request_with_seller_policy($1,$2,$3,$4,$5,$6) AS response",
      [" exact reversal key ", "correction", null, orderId, { ...proof, reason: "order_refunded" }, null],
    );
  },
);
it.each(["unknown", "blocked", "unsupported", "retryable", "absent"] as const)(
  "binds native fail %s to duty/token/generation/kind/evidence/delay", async kind => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { kind: "unknown" } }] }));
    const store = createPostgresInvoiceStore({ query }, { seller });
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
it("preserves the native fail stale result as a claim fence", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { kind: "stale" } }] }));
  const { claim } = issueFixture();
  expect(await createPostgresInvoiceStore({ query }).fail({ claim, kind: "unknown", proof, retrySeconds: 73 }))
    .toEqual({ kind: "stale" });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    "SELECT public.invoicing_fail_duty($1,$2,$3,$4,$5,$6) AS response",
    ["duty-a", "token-a", 4, "unknown", { proof }, 73],
  );
});
it.each(["inexact", "incomplete", "scope create identity", "scope fact revision", "scope request key", "evidence identity"] as const)(
  "refuses %s absence before querying the native store", async variant => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { kind: "unknown" } }] }));
    const { claim } = issueFixture("readback");
    const evidence = {
      kind: "absent" as const,
      identity: variant === "evidence identity" ? { ...claim.identity, providerCreateIdentity: "foreign-duty" } : claim.identity,
      evidence: { ...proof, exact: variant !== "inexact", complete: variant !== "incomplete",
        scope: { ...claim.identity,
          ...(variant === "scope create identity" ? { providerCreateIdentity: "foreign-duty" } : {}),
          ...(variant === "scope fact revision" ? { factRevision: "foreign-facts" } : {}),
          ...(variant === "scope request key" ? { requestKey: "foreign-key" } : {}),
        } },
    };
    // Exercise runtime refusal of provider evidence outside the exact/complete contract.
    expect(await createPostgresInvoiceStore({ query }).fail({ claim, kind: "absent", retrySeconds: 73,
      evidence: evidence as Extract<Parameters<InvoiceStorePort["fail"]>[0], { kind: "absent" }>["evidence"],
    })).toMatchObject({ kind: "unsupported", effectMayHaveSucceeded: false });
    expect(query).not.toHaveBeenCalled();
  },
);
it.each([
  { kind: "issued", correction: false }, { kind: "found", correction: false },
  { kind: "issued", correction: true }, { kind: "found", correction: true },
] as const)("binds native finish $kind (correction=$correction) to its RPC and proof kind", async ({ kind, correction }) => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { kind: "issued", replayed: false } }] }));
  const original = issueFixture().claim;
  const claim: Claim = correction ? { ...original,
    identity: { ...original.identity, operation: "full_reversal", correctionRef: "correction-a", parentProviderDocumentRef: "parent-a" },
    correction: { before: facts, reason: "order_refunded", after: { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 } },
  } : original;
  expect(await createPostgresInvoiceStore({ query }).finish({ claim,
    result: { kind, identity: claim.identity, providerDocumentRef: "remote-a", providerDocumentNumber: "REMOTE/A", proof, replayed: false },
  })).toEqual({ kind: "issued", replayed: false });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    correction ? "SELECT public.invoicing_finish_correction($1,$2,$3,$4,$5,$6) AS response"
      : "SELECT public.invoicing_finish_issue($1,$2,$3,$4,$5,$6) AS response",
    ["duty-a", "token-a", 4, "remote-a", "REMOTE/A", {
      kind: kind === "issued" ? "issued" : "readback_found", externalId: "remote-a",
      providerCreateIdentity: "invoicing:duty-a", parentExternalId: correction ? "parent-a" : null, proof,
    }],
  );
});
function issueFixture(action: "create" | "readback" = "create") {
  const claim: Claim = { dutyId: "duty-a", documentId: "doc-a", requestId: "req-a", token: "token-a", generation: 4,
    leaseUntil: "2026-10-22T12:00:00Z", facts, action, correction: null,
    identity: { providerRef: "host-a", requestKey: "key-a", providerCreateIdentity: "invoicing:duty-a", factRevision: "facts-a",
      orderRef: "ORDER/A", invoiceRef: "INVOICE/A", operation: "issue", correctionRef: null, parentProviderDocumentRef: null } };
  const issued = { kind: "issued" as const, identity: claim.identity, providerDocumentRef: "remote-a", providerDocumentNumber: null, proof, replayed: false };
  const store = { claim: vi.fn(async () => [claim]), preflight: vi.fn<InvoiceStorePort["preflight"]>(async () => ({ kind: "ready" })),
    finish: vi.fn<InvoiceStorePort["finish"]>(async () => ({ kind: "issued", replayed: false })),
    fail: vi.fn<InvoiceStorePort["fail"]>(async () => ({ kind: "recorded" })) };
  const provider = { issue: vi.fn<InvoiceProviderPort["issue"]>(async () => issued), correct: vi.fn<InvoiceProviderPort["correct"]>(async () => issued),
    read: vi.fn(async (): Promise<import("../../src/invoicing/contracts/index.js").InvoiceReadbackResult> => ({ ...issued, kind: "found" })) };
  const money = { read: vi.fn(async () => ({ kind: "observed" as const, status: "succeeded" as const, amountMinor: 900, currency: "XXX", proof })) };
  const readLocalPayment = vi.fn<Parameters<typeof runNativeInvoiceIssueJob>[0]["readLocalPayment"]>(async () => ({ kind: "unavailable" as const, code: "money_unavailable" as const }));
  return { claim, store, provider, money, readLocalPayment, run: () => runNativeInvoiceIssueJob({ store, provider, money, readLocalPayment, providerRef: "host-a", orderId: "order-a" }) };
}
it("native issue continues after unavailable local evidence, freshly checks money and uses generation as attemptCount", async () => {
  const f = issueFixture(); f.store.preflight.mockResolvedValueOnce({ kind: "unavailable" });
  expect(await f.run()).toEqual({ checked: 1, updated: 1, failures: 0, ok: true });
  expect(f.store.preflight.mock.calls.map(([v]) => v.status)).toEqual(["unavailable", "succeeded"]);
  expect(f.provider.issue).toHaveBeenCalledWith(expect.objectContaining({ recoveryLookupRequired: true, facts }));
  expect(f.store.fail).not.toHaveBeenCalled(); expect(f.provider.read).not.toHaveBeenCalled();
  expect(f.money.read).toHaveBeenCalledOnce();
  expect(f.readLocalPayment).toHaveBeenCalledExactlyOnceWith({ ...f.claim, attemptCount: 4 });
});
it.each(["mismatch", "blocked"] as const)("native local observed %s settles blocked before fresh money or dispatch", async kind => {
  const f = issueFixture();
  f.readLocalPayment.mockResolvedValue({ kind: "observed", status: "succeeded", amountMinor: 899, currency: "XXX", proof });
  f.store.preflight.mockResolvedValueOnce({ kind });
  expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.readLocalPayment).toHaveBeenCalledOnce();
  expect(f.store.preflight).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 },
    status: "succeeded", amountMinor: 899, currency: "XXX", proof });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 },
    retrySeconds: 1200, kind: "blocked", proof: null });
  expect(f.money.read).not.toHaveBeenCalled();
  expect(f.provider.issue).not.toHaveBeenCalled(); expect(f.provider.correct).not.toHaveBeenCalled();
  expect(f.store.finish).not.toHaveBeenCalled();
});
it.each(["blocked", "mismatch", "unavailable"] as const)("native fresh %s settles the claim before returning without dispatch", async kind => {
  const f = issueFixture(); f.store.preflight.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce({ kind });
  expect(await f.run()).toMatchObject({ updated: 0, failures: 1 });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 }, retrySeconds: 1200, proof: null,
    ...(kind === "unavailable" ? { kind: "retryable", phase: "before_send" } : { kind: "blocked" }) });
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

it.each(["failed", "pending"] as const)("preserves observed %s payment evidence in native preflight", async status => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { kind: "blocked" } }] }));
  const claim = issueFixture().claim;
  await createPostgresInvoiceStore({ query }).preflight({ claim, status, amountMinor: 900, currency: "XXX", proof });
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT public.invoicing_preflight_duty($1,$2,$3,$4) AS response",
    ["duty-a", "token-a", 4, { kind: "observed", outcome: status, amountMinor: 900, currency: "XXX", proof }]);
});
it("maps absent payment evidence to unavailable with the exact absence proof", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { kind: "unavailable" } }] }));
  const claim = issueFixture().claim;
  const evidence = { ...proof, exact: true as const, complete: true as const, scope: { intentRef: "intent-a", providerRef: "host-a", providerPaymentRef: null, expectedMoney: { amountMinor: 900, currency: "XXX" } } };
  await createPostgresInvoiceStore({ query }).preflight({ claim, status: "absent", amountMinor: null, currency: null, evidence });
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT public.invoicing_preflight_duty($1,$2,$3,$4) AS response",
    ["duty-a", "token-a", 4, { kind: "unavailable", outcome: "absent", amountMinor: null, currency: null, proof: evidence }]);
});
it("maps a native correction claim to the full parent identity and zero-after correction", async () => {
  const correctionFacts = { ...facts, before: facts, reason: "order_refunded", parentExternalId: "parent-remote-a" };
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [] }));
  query.mockResolvedValueOnce({ rows: [{ facts: correctionFacts }] }).mockResolvedValueOnce({ rows: [{ response: [
    { ...raw, parent_duty_id: "parent-duty-a", facts: correctionFacts },
  ] }] });
  const claims = await createPostgresInvoiceStore({ query }, { seller }).claim({ limit: 1, visibilitySeconds: 300, providerRef: "host-a" });
  expect(Array.isArray(claims)).toBe(true);
  const claim = (claims as readonly Claim[])[0]!;
  expect(claim.correction).toEqual({ before: facts, reason: "order_refunded", after: { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 } });
  expect(claim.identity).toEqual({ providerRef: "host-a", requestKey: "  Exact key  ", providerCreateIdentity: "invoicing:duty-a",
    factRevision: "facts-a", orderRef: "ORDER/A", invoiceRef: "INVOICE/A", operation: "full_reversal",
    correctionRef: "invoicing:duty-a", parentProviderDocumentRef: "parent-remote-a" });
});
it.each(["retryable refusal", "blocked refusal", "unsupported", "unknown"] as const)("native create settles %s with the exact failure kind and phase", async variant => {
  const f = issueFixture();
  f.provider.issue.mockResolvedValue(variant === "unsupported"
    ? { kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false }
    : variant === "unknown" ? { kind: "unknown", identity: f.claim.identity, code: "unknown", effectMayHaveSucceeded: true }
      : { kind: "refused", identity: f.claim.identity, code: "blocked", retryable: variant === "retryable refusal", effectMayHaveSucceeded: false });
  expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 }, retrySeconds: 1200, proof: null,
    ...(variant === "retryable refusal" ? { kind: "retryable", phase: "before_send" }
      : { kind: variant === "blocked refusal" ? "blocked" : variant }) });
  expect(f.store.finish).not.toHaveBeenCalled();
});
it.each(["local payment", "provider issue", "unsupported finish"] as const)("native %s failure preserves the dispatch boundary", async variant => {
  const f = issueFixture();
  if (variant === "local payment") f.readLocalPayment.mockRejectedValue(new Error("local_payment_unavailable"));
  if (variant === "provider issue") f.provider.issue.mockRejectedValue(new Error("provider_transport_failed"));
  if (variant === "unsupported finish") f.store.finish.mockResolvedValue({ kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false });
  expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 }, retrySeconds: 1200, proof: null,
    ...(variant === "local payment" ? { kind: "retryable", phase: "before_send" } : { kind: "unknown" }) });
  if (variant === "local payment") {
    expect(f.provider.issue).not.toHaveBeenCalled();
    expect(f.money.read).not.toHaveBeenCalled();
  } else expect(f.provider.issue).toHaveBeenCalledOnce();
});
it.each([1, 2, 3, 4])("native correction generation %s routes the exact correction and recovery requirement", async generation => {
  const f = issueFixture();
  const identity = { ...f.claim.identity, operation: "full_reversal" as const, correctionRef: "invoicing:duty-a", parentProviderDocumentRef: "parent-remote-a" };
  const correction = { before: facts, reason: "order_refunded", after: { totalNetMinor: 0 as const, totalTaxMinor: 0 as const, totalGrossMinor: 0 as const } };
  const claim = { ...f.claim, generation, identity, correction };
  f.store.claim.mockResolvedValue([claim]);
  expect(await f.run()).toEqual({ checked: 1, updated: 1, failures: 0, ok: true });
  expect(f.provider.correct).toHaveBeenCalledExactlyOnceWith({ identity, before: facts, reason: "order_refunded",
    after: { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 }, recoveryLookupRequired: generation > 1 });
  expect(f.provider.issue).not.toHaveBeenCalled();
});
it.each([1, 2, 3, 4])("native issue generation %s preserves the recovery boundary", async generation => {
  const f = issueFixture();
  f.store.claim.mockResolvedValue([{ ...f.claim, generation }]);
  expect(await f.run()).toEqual({ checked: 1, updated: 1, failures: 0, ok: true });
  expect(f.provider.issue).toHaveBeenCalledExactlyOnceWith({ identity: f.claim.identity, facts, recoveryLookupRequired: generation > 1 });
});

it("preserves every lease field, empty batches, exact claim filters and nullable order binding", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response: [raw] }] }));
  query.mockResolvedValueOnce({ rows: [] });
  const claims = await createPostgresInvoiceStore({ query }, { seller }).claim({ limit: 7, visibilitySeconds: 91, providerRef: "host-a" });
  expect(claims).toEqual([{ dutyId: raw.id, documentId: raw.document_id, requestId: raw.request_id, token: raw.claim_token,
    generation: 2, leaseUntil: raw.lease_until, facts: { ...facts, seller: selectedSeller, sellerRevision: "seller-v1", sellerMode: "frozen" }, identity: {
      ...issueFixture().claim.identity, requestKey: raw.original_key }, action: "readback", correction: null }]);
  expect(query.mock.calls[0]).toEqual([`SELECT f.facts FROM public.invoicing_duties d
        JOIN public.invoicing_fact_revisions f ON f.duty_id=d.id
        WHERE ($1::uuid IS NULL OR d.order_id=$1) AND (d.provider IS NULL OR d.provider=$2)
          AND d.status IN ('ready','processing','unknown') AND d.available_at<=now()
          AND (d.status<>'processing' OR d.lease_until<=now())`, [null, "host-a"]]);
  expect(query.mock.calls[1]).toEqual(["SELECT public.invoicing_claim_with_seller($1,$2,$3,$4,$5,$6) AS response", [7, 91, "host-a", selectedSeller, "seller-v1", null]]);
});

const invalidFactCases: readonly (readonly [string, (value: Record<string, unknown>) => void])[] = [
  ...["factRevision", "policyVersion", "documentKind"].flatMap(key => [null, 1, "", "   "].map(value =>
    [`${key}=${String(value)}`, (f: Record<string, unknown>) => { f[key] = value; }] as const)),
  ...["refs.orderId", "refs.orderRef", "refs.invoiceRef", "dates.issueDate", "dates.sellDate", "buyer.name", "payment.intentRef"].map(path =>
    [path, (f: Record<string, unknown>) => { const [parent, key] = path.split("."); (f[parent!] as Record<string, unknown>)[key!] = null; }] as const),
  ...["refs", "dates", "buyer", "payment"].map(key => [key, (f: Record<string, unknown>) => { f[key] = null; }] as const),
  ["currency length", f => { f.currency = "XX"; (f.payment as Record<string, unknown>).currency = "XX"; }],
  ["currency absent", f => { f.currency = null; (f.payment as Record<string, unknown>).currency = null; }],
  ["payment currency", f => { (f.payment as Record<string, unknown>).currency = "YYY"; }],
  ["clearance boolean", f => { f.clearanceRequired = null; }],
  ["lines absent", f => { f.lines = null; }], ["lines empty", f => { f.lines = []; }],
  ...["totalNetMinor", "totalTaxMinor", "totalGrossMinor", "chargedTotalGrossMinor"].map(key => [key, (f: Record<string, unknown>) => { f[key] = 901; }] as const),
  ...["totalNetMinor", "totalTaxMinor", "totalGrossMinor"].map(key => [key + " unsafe", (f: Record<string, unknown>) => { f[key] = 900.5; }] as const),
  ...["description", "quantity", "taxRateBps", "unitNetMinor", "unitGrossMinor", "totalNetMinor", "totalTaxMinor", "totalGrossMinor"].flatMap(key =>
    (key === "description" ? [null, "", "   ", 1] : key === "quantity" ? [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1] : key === "taxRateBps" ? [-1, 10001, 1.5] : [1.5, Number.MAX_SAFE_INTEGER + 1]).map(value =>
      [`line ${key}=${String(value)}`, (f: Record<string, unknown>) => { (f.lines as Record<string, unknown>[])[0]![key] = value; }] as const)),
  ["line negative net", f => { const line = (f.lines as Record<string, unknown>[])[0]!; line.totalNetMinor = -1; line.totalTaxMinor = 901; f.totalNetMinor = -1; f.totalTaxMinor = 901; }],
  ["line negative tax", f => { const line = (f.lines as Record<string, unknown>[])[0]!; line.totalNetMinor = 901; line.totalTaxMinor = -1; f.totalNetMinor = 901; f.totalTaxMinor = -1; }],
  ["line sum mismatch", f => { (f.lines as Record<string, unknown>[])[0]!.totalGrossMinor = 901; f.totalGrossMinor = 901; f.chargedTotalGrossMinor = 901; }],
  ["null line", f => { f.lines = [null]; }],
  ["null line net with balanced totals", f => {
    const line = (f.lines as Record<string, unknown>[])[0]!; line.totalNetMinor = null; line.totalGrossMinor = 150;
    f.totalNetMinor = 0; f.totalGrossMinor = 150; f.chargedTotalGrossMinor = 150;
  }],
  ["null line tax with balanced totals", f => {
    const line = (f.lines as Record<string, unknown>[])[0]!; line.totalTaxMinor = null; line.totalGrossMinor = 750;
    f.totalTaxMinor = 0; f.totalGrossMinor = 750; f.chargedTotalGrossMinor = 750;
  }],
  ["empty zero invoice", f => { f.lines = []; f.totalNetMinor = 0; f.totalTaxMinor = 0; f.totalGrossMinor = 0; f.chargedTotalGrossMinor = 0; }],
  ["declared gross differs from lines", f => { f.totalGrossMinor = 901; f.chargedTotalGrossMinor = 901; }],
  ["unsafe aggregate", f => {
    const line = { ...(f.lines as Record<string, unknown>[])[0], totalNetMinor: Number.MAX_SAFE_INTEGER, totalTaxMinor: 0, totalGrossMinor: Number.MAX_SAFE_INTEGER };
    f.lines = [line, line]; f.totalNetMinor = Number.MAX_SAFE_INTEGER * 2; f.totalTaxMinor = 0;
    f.totalGrossMinor = Number.MAX_SAFE_INTEGER * 2; f.chargedTotalGrossMinor = f.totalGrossMinor;
  }],
];
it.each(invalidFactCases)("refuses invalid fiscal projection %s before install and lease writes", async (_name, mutate) => {
  const invalid = structuredClone(facts) as unknown as Record<string, unknown>; mutate(invalid);
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response: [] }] }));
  const store = createPostgresInvoiceStore({ query }, { seller });
  await expect(store.installFacts({ dutyId: "duty-a", facts: invalid as unknown as InvoiceFacts })).resolves.toEqual({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false });
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ rows: [{ facts: invalid }] });
  await expect(store.claim({ limit: 1, visibilitySeconds: 30, providerRef: "host-a" })).resolves.toMatchObject({ kind: "unsupported" });
  expect(query).toHaveBeenCalledTimes(1);
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ response: [{ ...raw, facts: invalid }] }] });
  await expect(store.claim({ limit: 1, visibilitySeconds: 30, providerRef: "host-a" })).rejects.toThrow();
});
it("accepts multiple fiscal lines, tax endpoints and both clearance values without dropping sums", async () => {
  for (const clearanceRequired of [false, true]) for (const taxRateBps of [0, 10000]) {
    const f = { ...facts, clearanceRequired, lines: [facts.lines[0]!, { ...facts.lines[0]!, quantity: 2, taxRateBps }], totalNetMinor: 1500, totalTaxMinor: 300, totalGrossMinor: 1800, chargedTotalGrossMinor: 1800 };
    const query = vi.fn(async () => ({ rows: [{ response: { dutyId: "duty-a", status: "owed" } }] }));
    expect(await createPostgresInvoiceStore({ query }).installFacts({ dutyId: "duty-a", facts: f })).toEqual({ dutyId: "duty-a", status: "owed" });
  }
});
it.each(["providerRef", "requestKey", "providerCreateIdentity", "factRevision", "orderRef", "invoiceRef", "operation", "correctionRef", "parentProviderDocumentRef"] as const)("fences finish and both absence identities on %s", async key => {
  const claim = issueFixture().claim, foreign = { ...claim.identity, [key]: "foreign" };
  const query = vi.fn(async () => ({ rows: [{ response: { kind: "recorded" } }] })); const store = createPostgresInvoiceStore({ query }, { seller });
  expect(await store.finish({ claim, result: { kind: "found", identity: foreign, providerDocumentRef: "remote", providerDocumentNumber: null, proof } })).toMatchObject({ kind: "unsupported" });
  for (const identity of [foreign, claim.identity]) {
    expect(await store.fail({ claim, kind: "absent", retrySeconds: 23, evidence: { kind: "absent", identity,
      evidence: { ...proof, exact: true, complete: true, scope: identity === foreign ? claim.identity : foreign } } })).toMatchObject({ kind: "unsupported" });
  }
  expect(query).not.toHaveBeenCalled();
});
it.each([
  { status: "unavailable", amountMinor: 900, currency: "XXX", expected: "unavailable" },
  { status: "unknown", amountMinor: 900, currency: "XXX", expected: "unavailable" },
  { status: "succeeded", amountMinor: 900, currency: null, expected: "unavailable" },
] as const)("maps independent unavailable evidence $status/$currency", async ({ status, amountMinor, currency, expected }) => {
  const query = vi.fn(async () => ({ rows: [{ response: { kind: "unavailable" } }] })); const claim = issueFixture().claim;
  await createPostgresInvoiceStore({ query }).preflight({ claim, status, amountMinor, currency, proof });
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT public.invoicing_preflight_duty($1,$2,$3,$4) AS response", ["duty-a", "token-a", 4,
    { kind: expected, outcome: status === "succeeded" ? "captured" : status, amountMinor, currency, proof }]);
});
it("binds sweep, prepare/finish facts and duty reads and preserves missing RPC response refusal", async () => {
  const response = { status: "ready", requestId: "req-a", documentId: "doc-a" };
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response }] })); const store = createPostgresInvoiceStore({ query }, { seller });
  expect(await store.sweep(37)).toEqual(response); expect(query).toHaveBeenLastCalledWith("SELECT public.invoicing_sweep_duties($1) AS response", [37]);
  for (const kind of [undefined, "retryable", "legacy_facts_unproved"] as const) {
    query.mockResolvedValueOnce({ rows: [{ response: { ...response, ...(kind ? { kind } : {}) } }] });
    expect(await store.prepareFacts({ dutyId: "duty-a", token: "facts-token" })).toStrictEqual({ ...response, ...(kind ? { code: kind } : {}) });
    expect(query).toHaveBeenLastCalledWith("SELECT public.invoicing_prepare_facts($1,$2) AS response", ["duty-a", "facts-token"]);
  }
  expect(await store.finishFacts({ dutyId: "duty-a", token: "facts-token", result: { status: "ready", requestId: "req-a" } })).toEqual({ ...response, dutyId: "duty-a" });
  expect(query).toHaveBeenLastCalledWith("SELECT public.invoicing_finish_facts($1,$2,$3) AS response", ["duty-a", "facts-token", { status: "ready", requestId: "req-a", kind: undefined }]);
  expect(await store.readDuties("order-a")).toEqual(response); expect(query).toHaveBeenLastCalledWith("SELECT public.invoicing_duty_readback($1) AS response", ["order-a"]);
  for (const rows of [[], [{}]]) { query.mockResolvedValueOnce({ rows }); await expect(store.sweep(1)).rejects.toThrow("invoicing_native_response_missing"); }
});
it.each([undefined, {}, { document: { id: 1, status: "ready" }, replayed: true }, { document: { id: "doc", status: null }, replayed: true }, { document: { id: "doc", status: "ready" } }])("refuses malformed local document response %# before reference read", async response => {
  const query = vi.fn(async () => ({ rows: [{ response }] }));
  await expect(createPostgresInvoiceStore({ query }).requestLocalDocument({ requestKey: "local-key", orderId: "order-a", providerRef: "local" })).rejects.toThrow("accounting_paid_order_document_response_invalid");
  expect(query).toHaveBeenCalledOnce();
});
it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ document_ref: 1 }] }])("refuses missing local document reference %#", async ({ rows }) => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows }));
  query.mockResolvedValueOnce({ rows: [{ response: { document: { id: "local-doc", status: "issued" }, replayed: false } }] });
  await expect(createPostgresInvoiceStore({ query }).requestLocalDocument({ requestKey: "local-key", orderId: "order-a", providerRef: "local" })).rejects.toThrow("accounting_paid_order_document_reference_missing");
  expect(query).toHaveBeenLastCalledWith("SELECT document_ref FROM public.accounting_documents WHERE id=$1::uuid", ["local-doc"]);
});
it("native claim refusal and empty batches preserve the batch result without I/O", async () => {
  const f = issueFixture();
  for (const batch of [[], { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false }] as const) {
    const claim = vi.fn<InvoiceStorePort["claim"]>(async () => batch);
    const result = await runNativeInvoiceIssueJob({ ...f, store: { ...f.store, claim }, providerRef: "host-a" });
    expect(result).toEqual(Array.isArray(batch) ? { checked: 0, updated: 0, failures: 0, ok: true } : batch);
    expect(claim).toHaveBeenCalledExactlyOnceWith({ limit: 10, visibilitySeconds: 300, providerRef: "host-a", orderId: undefined });
  }
  expect(f.readLocalPayment).not.toHaveBeenCalled(); expect(f.provider.issue).not.toHaveBeenCalled();
});
it("native explicit claim limits and money routing preserve host references", async () => {
  const f = issueFixture();
  const payment = { ...facts.payment, amountMinor: 907, providerRef: "money-host", providerPaymentRef: "provider-payment-a" };
  const lines = [
    { ...facts.lines[0]!, quantity: 2, unitNetMinor: 100, unitGrossMinor: 120, totalNetMinor: 200, totalTaxMinor: 40, totalGrossMinor: 240 },
    { ...facts.lines[0]!, description: "Second item", quantity: 5, unitNetMinor: 110, unitGrossMinor: 132, totalNetMinor: 550, totalTaxMinor: 110, totalGrossMinor: 660 },
  ];
  const claim = { ...f.claim, facts: { ...facts, payment, lines } };
  f.store.claim.mockResolvedValue([claim]);
  expect(await runNativeInvoiceIssueJob({ ...f, providerRef: "host-a", orderId: "order-a", limit: 7, visibilitySeconds: 83 })).toEqual({ checked: 1, updated: 1, failures: 0, ok: true });
  expect(f.store.claim).toHaveBeenCalledExactlyOnceWith({ limit: 7, visibilitySeconds: 83, providerRef: "host-a", orderId: "order-a" });
  expect(f.money.read).toHaveBeenCalledExactlyOnceWith({ intentRef: "intent-a", providerRef: "money-host", providerPaymentRef: "provider-payment-a", expectedMoney: { amountMinor: 900, currency: "XXX" } });
  expect(f.store.preflight.mock.calls).toEqual([
    [{ claim: { ...claim, attemptCount: 4 }, status: "unavailable", amountMinor: null, currency: null, proof: null }],
    [{ claim: { ...claim, attemptCount: 4 }, status: "succeeded", amountMinor: 900, currency: "XXX", proof }],
  ]);
  expect(f.store.finish).toHaveBeenCalledExactlyOnceWith({ claim: { ...claim, attemptCount: 4 }, result: await f.provider.issue.mock.results[0]!.value });
});
it.each(["absent", "unavailable", "failed", "pending"] as const)("native fresh money %s passes exact preflight evidence", async variant => {
  const f = issueFixture();
  const evidence = { ...proof, exact: true as const, complete: true as const, scope: { intentRef: "intent-a", providerRef: "host-a", providerPaymentRef: null, expectedMoney: { amountMinor: 900, currency: "XXX" } } };
  const read = vi.fn<Parameters<typeof runNativeInvoiceIssueJob>[0]["money"]["read"]>(async () => variant === "absent" ? { kind: "absent", evidence }
    : variant === "unavailable" ? { kind: "unavailable", code: "money_unavailable" }
      : { kind: "observed", status: variant, amountMinor: 901, currency: "YYY", proof });
  f.store.preflight.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce({ kind: "unavailable" });
  expect(await runNativeInvoiceIssueJob({ ...f, money: { read }, providerRef: "host-a" })).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(read).toHaveBeenCalledExactlyOnceWith({ intentRef: "intent-a", providerRef: "host-a", providerPaymentRef: null, expectedMoney: { amountMinor: 900, currency: "XXX" } });
  expect(f.store.preflight.mock.calls[1]).toEqual([{ claim: { ...f.claim, attemptCount: 4 }, amountMinor: variant === "failed" || variant === "pending" ? 901 : null,
    currency: variant === "failed" || variant === "pending" ? "YYY" : null,
    ...(variant === "absent" ? { status: "absent", evidence } : { status: variant, proof: variant === "unavailable" ? null : proof }) }]);
});
it.each([0, 1, 2, 12, 13])("native generation %s bounds failure delay and keeps attempt count", async generation => {
  const f = issueFixture(); const claim = { ...f.claim, generation };
  f.store.claim.mockResolvedValue([claim]); f.readLocalPayment.mockRejectedValue(new Error("local unavailable"));
  expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...claim, attemptCount: generation }, retrySeconds: Math.min(3600, 300 * Math.max(1, generation)), kind: "retryable", phase: "before_send", proof: null });
});
it.each(["found", "absent", "unknown", "throw"] as const)("native readback %s preserves exact settlement and dispatch boundary", async variant => {
  const f = issueFixture("readback");
  const absence = { kind: "absent" as const, identity: f.claim.identity, evidence: { ...proof, exact: true as const, complete: true as const, scope: f.claim.identity } };
  if (variant === "absent") f.provider.read.mockResolvedValue(absence);
  if (variant === "unknown") f.provider.read.mockResolvedValue({ kind: "unknown", identity: f.claim.identity, code: "unknown" });
  if (variant === "throw") f.provider.read.mockRejectedValue(new Error("read failed"));
  expect(await f.run()).toEqual({ checked: 1, updated: variant === "found" ? 1 : 0, failures: variant === "found" ? 0 : 1, ok: variant === "found" });
  expect(f.provider.read).toHaveBeenCalledExactlyOnceWith(f.claim.identity);
  if (variant === "found") {
    expect(f.store.finish).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 }, result: await f.provider.read.mock.results[0]!.value });
    expect(f.store.fail).not.toHaveBeenCalled();
  } else expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 }, retrySeconds: 1200,
    ...(variant === "absent" ? { kind: "absent", evidence: absence } : { kind: "unknown", proof: null }) });
});
it.each(["local", "fresh", "finish", "readback finish", "blocked fail", "readback fail", "dispatch fail"] as const)("native stale %s stops all further settlement", async phase => {
  const f = issueFixture(phase.startsWith("readback") ? "readback" : "create");
  if (phase === "local") f.store.preflight.mockResolvedValueOnce({ kind: "stale" });
  if (phase === "fresh") f.store.preflight.mockResolvedValueOnce({ kind: "ready" }).mockResolvedValueOnce({ kind: "stale" });
  if (phase.endsWith("finish")) f.store.finish.mockResolvedValueOnce({ kind: "stale" });
  if (phase === "blocked fail") f.store.preflight.mockResolvedValueOnce({ kind: "blocked" });
  if (phase === "readback fail") f.provider.read.mockResolvedValue({ kind: "unknown", identity: f.claim.identity, code: "unknown" });
  if (phase === "dispatch fail") f.provider.issue.mockResolvedValue({ kind: "unknown", identity: f.claim.identity, code: "unknown", effectMayHaveSucceeded: true });
  f.store.fail.mockResolvedValue({ kind: "stale" });
  expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.store.fail).toHaveBeenCalledTimes(phase.endsWith("fail") ? 1 : 0);
});
it.each(["local", "fresh", "finish", "fail", "catch stale", "catch unsupported", "catch throw"] as const)("native unsupported/error %s checks settlement results", async phase => {
  const f = issueFixture(); const unsupported = { kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false } as const;
  if (phase === "local") f.store.preflight.mockResolvedValueOnce(unsupported);
  if (phase === "fresh") f.store.preflight.mockResolvedValueOnce({ kind: "ready" }).mockResolvedValueOnce(unsupported);
  if (phase === "finish") f.store.finish.mockResolvedValueOnce(unsupported);
  if (phase === "fail") { f.store.preflight.mockResolvedValueOnce({ kind: "blocked" }); f.store.fail.mockResolvedValueOnce(unsupported); }
  if (phase.startsWith("catch")) { f.readLocalPayment.mockRejectedValue(new Error("unavailable"));
    if (phase === "catch throw") f.store.fail.mockRejectedValue(new Error("failure write failed"));
    else f.store.fail.mockResolvedValue(phase === "catch stale" ? { kind: "stale" } : unsupported);
  }
  if (phase === "catch unsupported" || phase === "catch throw") await expect(f.run()).rejects.toThrow(phase === "catch throw" ? "failure write failed" : "invoicing_host_binding_required");
  else expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.store.fail).toHaveBeenCalledTimes(phase === "fail" ? 2 : 1);
  expect(f.store.fail).toHaveBeenLastCalledWith({ claim: { ...f.claim, attemptCount: 4 }, retrySeconds: 1200, proof: null,
    ...(phase === "finish" ? { kind: "unknown" } : { kind: "retryable", phase: "before_send" }) });
});
it("native mixed batch counts every duty and continues after a failure", async () => {
  const f = issueFixture(); f.store.claim.mockResolvedValue([f.claim, { ...f.claim, dutyId: "duty-b" }, { ...f.claim, dutyId: "duty-c" }]);
  f.readLocalPayment.mockRejectedValueOnce(new Error("first unavailable"));
  expect(await f.run()).toEqual({ checked: 3, updated: 2, failures: 1, ok: false });
  expect(f.readLocalPayment).toHaveBeenCalledTimes(3); expect(f.provider.issue).toHaveBeenCalledTimes(2); expect(f.store.finish).toHaveBeenCalledTimes(2);
  expect(f.store.fail).toHaveBeenCalledOnce();
});

it("emits the bounded discovery and incumbent paid-order snapshot SQL contracts", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [] }));
  const store = createPostgresInvoiceStore({ query }, { seller });
  expect(await store.discoverDuties(11, "cursor-a")).toEqual([]);
  expect(query).toHaveBeenLastCalledWith(`SELECT d.id AS "dutyId", d.order_id AS "orderId"
        FROM public.invoicing_duties d
        WHERE ($2::uuid IS NULL OR d.id>$2::uuid)
          AND d.request_id IS NULL AND d.status IN ('owed','blocked')
          AND d.reversal IS NULL AND d.available_at<=now()
          AND NOT EXISTS (SELECT 1 FROM public.invoicing_fact_revisions f WHERE f.duty_id=d.id)
        ORDER BY d.id LIMIT least(greatest(coalesce($1::integer,10),1),100)`, [11, "cursor-a"]);
  query.mockResolvedValueOnce({ rows: [{ response: { document: { id: "local-doc", status: "issued" }, replayed: false } }] }).mockResolvedValueOnce({ rows: [{ document_ref: "LOCAL/B" }] });
  expect(await store.requestLocalDocument({ requestKey: "local-key", orderId: "order-a", providerRef: "local-host" })).toEqual({ kind: "requested", documentId: "local-doc", invoiceRef: "LOCAL/B", replayed: false, status: "issued" });
  expect(query.mock.calls[1]).toEqual([`
  WITH snapshot AS (
    SELECT
      order_row.total_amount_minor,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'description', 'order position ' || item.line_ordinal::text,
            'quantity', item.quantity,
            'unitGrossMinor', item.unit_amount_minor,
            'totalGrossMinor', item.line_amount_minor,
            'taxRateBps', 0
          ) ORDER BY item.line_ordinal
        ) FILTER (WHERE item.id IS NOT NULL),
        '[]'::jsonb
      ) AS positions
    FROM public.commerce_orders order_row
    LEFT JOIN public.commerce_order_items item ON item.order_id = order_row.id
    WHERE order_row.id = $2::uuid
    GROUP BY order_row.id, order_row.total_amount_minor
  )
  SELECT public.accounting_document_request_from_paid_order(
    $1, $2::uuid, snapshot.positions, snapshot.total_amount_minor,
    jsonb_build_object('providerKind', $3::text)
  ) AS response
  FROM snapshot`, ["local-key", "order-a", "local-host"]]);
  expect(query.mock.calls[2]).toEqual(["SELECT document_ref FROM public.accounting_documents WHERE id=$1::uuid", ["local-doc"]]);
});
it("absent status remains unavailable even when a caller supplies money values", async () => {
  const query = vi.fn(async () => ({ rows: [{ response: { kind: "unavailable" } }] })); const claim = issueFixture().claim;
  const evidence = { ...proof, exact: true as const, complete: true as const, scope: { intentRef: "intent-a", providerRef: "host-a", providerPaymentRef: null, expectedMoney: { amountMinor: 900, currency: "XXX" } } };
  await createPostgresInvoiceStore({ query }).preflight({ claim, status: "absent", amountMinor: 900, currency: "XXX", evidence });
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT public.invoicing_preflight_duty($1,$2,$3,$4) AS response", ["duty-a", "token-a", 4,
    { kind: "unavailable", outcome: "absent", amountMinor: 900, currency: "XXX", proof: evidence }]);
});
it("native unknown effect remains unknown even with an extra retryable hint", async () => {
  const f = issueFixture();
  const result = { kind: "unknown" as const, identity: f.claim.identity, code: "unknown" as const, effectMayHaveSucceeded: true as const, retryable: true };
  f.provider.issue.mockResolvedValue(result);
  expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...f.claim, attemptCount: 4 }, retrySeconds: 1200, kind: "unknown", proof: null });
});
it("preserves create action and distinct identifiers in a second native lease", async () => {
  const row = { ...raw, id: "duty-b", document_id: "document-b", request_id: "request-b", claim_token: "token-b", generation: 7,
    lease_until: "2026-10-23T14:00:00Z", original_key: "second-key", providerCreateIdentity: "invoicing:duty-b", last_result: { action: "create" } };
  const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response: [row] }] }));
  query.mockResolvedValueOnce({ rows: [{ facts }] });
  expect(await createPostgresInvoiceStore({ query }, { seller }).claim({ limit: 2, visibilitySeconds: 90, providerRef: "host-a" })).toEqual([
    { dutyId: "duty-b", documentId: "document-b", requestId: "request-b", token: "token-b", generation: 7, leaseUntil: row.lease_until,
      facts: { ...facts, seller: selectedSeller, sellerRevision: "seller-v1", sellerMode: "frozen" }, action: "create", correction: null, identity: { ...issueFixture().claim.identity, requestKey: "second-key", providerCreateIdentity: "invoicing:duty-b" } },
  ]);
});
it.each(["fresh money", "correction", "finish"] as const)("native thrown %s respects the remote boundary", async phase => {
  const f = issueFixture();
  if (phase === "fresh money") f.money.read.mockRejectedValue(new Error("fresh money unavailable"));
  if (phase === "finish") f.store.finish.mockRejectedValue(new Error("finish write failed"));
  if (phase === "correction") {
    f.store.claim.mockResolvedValue([{ ...f.claim, correction: { before: facts, reason: "refund", after: { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 } } }]);
    f.provider.correct.mockRejectedValue(new Error("correction transport failed"));
  }
  expect(await f.run()).toEqual({ checked: 1, updated: 0, failures: 1, ok: false });
  expect(f.store.fail).toHaveBeenCalledExactlyOnceWith({ claim: { ...(await f.store.claim.mock.results[0]!.value)[0], attemptCount: 4 }, retrySeconds: 1200, proof: null,
    ...(phase === "fresh money" ? { kind: "retryable", phase: "before_send" } : { kind: "unknown" }) });
});

it("accepts an explicit zero-value fiscal line and zero totals", async () => {
  const zero: InvoiceFacts = { ...facts, payment: { ...facts.payment, amountMinor: 0 },
    lines: [{ ...facts.lines[0]!, unitNetMinor: 0, unitGrossMinor: 0, totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0, taxRateBps: 0 }],
    totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0, chargedTotalGrossMinor: 0 };
  const query = vi.fn(async () => ({ rows: [{ response: { dutyId: "duty-zero", status: "owed" } }] }));
  expect(await createPostgresInvoiceStore({ query }).installFacts({ dutyId: "duty-zero", facts: zero })).toEqual({ dutyId: "duty-zero", status: "owed" });
  expect(query).toHaveBeenCalledOnce();
});
