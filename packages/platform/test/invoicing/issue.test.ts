import { expect, expectTypeOf, it, vi } from "vitest";
import { facts, identity, proof, sqlCall, expectPinnedSqlOrder } from "./portFitFixtures.js";
import type { InvoiceHostPorts, InvoiceProviderPort, InvoiceStorePort, InvoiceWriteResult } from "../../src/invoicing/contracts/index.js";
import { runInvoiceIssueJob } from "../../src/invoicing/index.js";

function subject() {
  const trace: string[] = [];
  const claim = { attemptCount: 2, id: "claim-final", generation: 7 };
  const snapshot = { orderRef: "ORDER/unchanged", currency: "XTS", lines: [{ name: "Saved item", totalGrossMinor: 1080 }] };
  const evidence = { status: "succeeded", amount: 1080, currency: "XTS" };
  const result = { providerDocumentRef: "remote", providerDocumentNumber: null };
  const input = {
    createEnabled: true, providerEnabled: true,
    claim: vi.fn(async () => { trace.push("claim"); return [claim]; }),
    localPreflight: vi.fn(async (c: typeof claim) => { expect(c).toBe(claim); trace.push("local"); return true; }),
    project: vi.fn((c: typeof claim) => { expect(c).toBe(claim); trace.push("project"); return snapshot; }),
    blockMapper: vi.fn(async () => { trace.push("block"); }),
    readPayment: vi.fn(async (c: typeof claim) => { expect(c).toBe(claim); trace.push("money"); return evidence; }),
    freshPreflight: vi.fn(async (c: typeof claim, e: typeof evidence) => { expect(c).toBe(claim); expect(e).toBe(evidence); trace.push("fresh"); return true; }),
    create: vi.fn(async (s: typeof snapshot, options: { recoveryLookupRequired: boolean }) => { expect(s).toBe(snapshot); expect(JSON.stringify([s, options])).toBe('[{"orderRef":"ORDER/unchanged","currency":"XTS","lines":[{"name":"Saved item","totalGrossMinor":1080}]},{"recoveryLookupRequired":true}]'); trace.push("create"); return result; }),
    finish: vi.fn(async (c: typeof claim, r: typeof result) => { expect(c).toBe(claim); expect(r).toBe(result); trace.push("finish"); }),
    isClaimFenceError: (error: unknown) => error === fence,
    fail: vi.fn(async () => { trace.push("fail"); }),
  };
  return { input, trace, claim, result };
}
const fence = new Error("stale claim");

it("preserves whole request bytes and local/projection/fresh-money/create/fenced-finalize order", async () => {
  const s = subject();
  expect(await runInvoiceIssueJob(s.input)).toEqual({ ok: true, checked: 1, updated: 1, skipped: false, failures: 0 });
  expect(s.trace).toEqual(["claim", "local", "project", "money", "fresh", "create", "finish"]);
  expect(s.input.fail).not.toHaveBeenCalled();
  await frozenSeamWitness();
});

it("does not retry terminal preflights or canonical refusals and never claims when disabled", async () => {
  for (const stage of ["disabled", "missing", "local", "mapper", "fresh"] as const) {
    const s = subject();
    if (stage === "disabled") s.input.createEnabled = false;
    if (stage === "missing") s.input.providerEnabled = false;
    if (stage === "local") s.input.localPreflight.mockResolvedValue(false);
    if (stage === "mapper") s.input.project.mockImplementation(() => { throw new Error("accounting_invoice_canonical_positions_header_mismatch"); });
    if (stage === "fresh") s.input.freshPreflight.mockResolvedValue(false);
    const result = await runInvoiceIssueJob(s.input);
    expect(result.updated).toBe(0);
    expect(s.input.create).not.toHaveBeenCalled();
    expect(s.input.fail).not.toHaveBeenCalled();
    if (stage === "disabled" || stage === "missing") expect(s.input.claim).not.toHaveBeenCalled();
    if (stage === "local" || stage === "mapper") expect(s.input.readPayment).not.toHaveBeenCalled();
    if (stage === "mapper") expect(s.input.blockMapper).toHaveBeenCalledWith(s.claim, "accounting_invoice_canonical_positions_header_mismatch", expect.any(Error));
  }
});

it("fences stale issue ACK without failing a newer lease and retains uncertain retry/recovery", async () => {
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "unknown" }>>().not.toMatchTypeOf<Awaited<ReturnType<Parameters<typeof runInvoiceIssueJob>[0]["create"]>>>();
  const stale = subject();
  stale.input.finish.mockRejectedValueOnce(fence);
  expect(await runInvoiceIssueJob(stale.input)).toMatchObject({ updated: 0, failures: 1 });
  expect(stale.input.fail).not.toHaveBeenCalled();
  const lost = subject();
  const unknown = new Error("lookup outcome unknown");
  lost.input.create.mockRejectedValueOnce(unknown);
  expect(await runInvoiceIssueJob(lost.input)).toMatchObject({ updated: 0, failures: 1 });
  expect(lost.input.finish).not.toHaveBeenCalled();
  expect(lost.input.fail).toHaveBeenCalledWith(lost.claim, unknown, 600);
  // Recovery belongs to the selected provider; the worker cannot downgrade its
  // unknown lookup to absence or turn recoveryLookupRequired off on replay.
  expect(lost.input.create).toHaveBeenCalledTimes(1);
  expect(lost.input.create.mock.calls[0][1]).toEqual({ recoveryLookupRequired: true });
});

// Exercise the compatibility callbacks against frozen ports. This is an offline
// binding witness, not a native store implementation or P8 seller-freeze claim.
async function frozenSeamWitness() {
  const claim = {
    dutyId: "duty-a", documentId: "document-a", requestId: "request-a", token: "lease-a", generation: 7,
    leaseUntil: "2026-10-22T12:06:00Z", identity, facts, action: "readback", correction: null,
    attemptCount: 2,
  } as const;
  const fences = [["p_duty", "input.claim.dutyId"], ["p_token", "input.claim.token"], ["p_generation", "input.claim.generation"]] as const;
  const mappings = [
    sqlCall("claim", "190000_invoicing_durable_duties", "invoicing_claim_duties", [["p_limit", "input.limit"], ["p_visibility", "input.visibilitySeconds"], ["p_provider", "input.providerRef"], ["p_order_id", "input.orderId"]], {}),
    sqlCall("preflight", "190000_invoicing_durable_duties", "invoicing_preflight_duty", [...fences, ["p_evidence", "input.status", "input.amountMinor", "input.currency", "input.proof", "input.evidence"]], {}),
    sqlCall("finish", "190000_invoicing_durable_duties", "invoicing_finish_issue", [...fences, ["p_external", "input.result.providerDocumentRef"], ["p_number", "input.result.providerDocumentNumber"], ["p_proof", "input.result.proof", "input.result.kind", "input.result.identity", "input.claim.identity"]], {}),
    sqlCall("fail", "190000_invoicing_durable_duties", "invoicing_fail_duty", [...fences, ["p_kind", "input.kind"], ["p_evidence", "input.phase", "input.proof", "input.evidence"], ["p_delay", "input.retrySeconds"]], {}),
  ];
  for (const mapping of mappings) expectPinnedSqlOrder(mapping.fixture, mapping.name, mapping.args.map(([parameter]) => parameter));
  for (const outcome of ["issued", "unknown", "mapper"] as const) {
    const trace: unknown[] = [];
    const store: Pick<InvoiceStorePort, "claim" | "preflight" | "finish" | "fail"> = {
      async claim(input) {
        // Pin SQL argument values as well as signature order, including scope.
        trace.push([input.limit, input.visibilitySeconds, input.providerRef, input.orderId]);
        return [claim];
      },
      async preflight(input) {
        expect(input.claim).toBe(claim);
        trace.push([input.claim.dutyId, input.claim.token, input.claim.generation, input]);
        return { kind: "ready" };
      },
      async finish(input) {
        expect(input.claim).toBe(claim);
        trace.push([input.claim.dutyId, input.claim.token, input.claim.generation, input.result.providerDocumentRef, input.result.providerDocumentNumber, input.result.proof]);
        return { kind: "issued", replayed: false };
      },
      async fail(input) {
        if (input.kind === "absent") throw new Error("unexpected_absence_fixture");
        expect(input.claim).toBe(claim);
        trace.push([input.claim.dutyId, input.claim.token, input.claim.generation, input.kind, input.proof, input.retrySeconds]);
        return { kind: "recorded" };
      },
    };
    if (facts.payment.providerRef === null) throw new Error("missing_provider_fixture");
    const moneyInput = { intentRef: facts.payment.intentRef, providerRef: facts.payment.providerRef, providerPaymentRef: facts.payment.providerPaymentRef, expectedMoney: { amountMinor: facts.payment.amountMinor, currency: facts.payment.currency } };
    const money: InvoiceHostPorts["money"] = { async read(input) {
      expect(input).toEqual(moneyInput);
      trace.push("money");
      return { kind: "observed", status: "succeeded", amountMinor: facts.totalGrossMinor, currency: facts.currency, proof };
    } };
    const issue: InvoiceProviderPort["issue"] = async (input) => {
      expect(input).toEqual({ identity, facts, recoveryLookupRequired: true });
      trace.push("create");
      return outcome === "unknown" ? { kind: "unknown", identity, code: "unknown", effectMayHaveSucceeded: true } : { kind: "issued", identity, providerDocumentRef: "external-a", providerDocumentNumber: null, proof, replayed: false };
    };
    const local = { claim, status: "unavailable", amountMinor: null, currency: null, proof: null } as const;
    const fresh = { claim, status: "succeeded", amountMinor: facts.totalGrossMinor, currency: facts.currency, proof } as const;
    const result = await runInvoiceIssueJob({
      createEnabled: true, providerEnabled: true,
      claim: async () => {
        const claims = await store.claim({ limit: 10, visibilitySeconds: 300, providerRef: identity.providerRef, orderId: facts.refs.orderId });
        if (!Array.isArray(claims)) throw new Error("unexpected_unsupported_fixture");
        return claims as (typeof claim)[];
      },
      localPreflight: async () => (await store.preflight(local)).kind === "ready",
      project: () => { trace.push("project"); if (outcome === "mapper") throw new Error("accounting_invoice_canonical_positions_header_mismatch"); return { identity, facts }; },
      blockMapper: async () => { await store.fail({ claim, kind: "blocked", proof: null, retrySeconds: 0 }); },
      readPayment: () => money.read(moneyInput),
      freshPreflight: async (c, evidence) => {
        expect(c).toBe(claim);
        if (evidence.kind !== "observed") return false;
        return (await store.preflight({ claim: c, status: evidence.status, amountMinor: evidence.amountMinor, currency: evidence.currency, proof: evidence.proof })).kind === "ready";
      },
      create: async (snapshot, options) => {
        const receipt = await issue({ ...snapshot, ...options });
        if (receipt.kind !== "issued") throw new Error("unacknowledged_fixture");
        return receipt;
      },
      finish: async (c, receipt) => { await store.finish({ claim: c, result: receipt }); },
      isClaimFenceError: () => false,
      // An ambiguous provider failure is never a retryable before-send refusal.
      fail: async (c, _error, retrySeconds) => { await store.fail({ claim: c, kind: "unknown", proof: null, retrySeconds }); },
    });
    const prefix = [[10, 300, "fiscal-a", "order-a"], ["duty-a", "lease-a", 7, local], "project"];
    expect(trace).toEqual(outcome === "mapper" ? [...prefix, ["duty-a", "lease-a", 7, "blocked", null, 0]] : [...prefix, "money", ["duty-a", "lease-a", 7, fresh], "create", outcome === "issued" ? ["duty-a", "lease-a", 7, "external-a", null, proof] : ["duty-a", "lease-a", 7, "unknown", null, 600]]);
    expect(result.updated).toBe(outcome === "issued" ? 1 : 0);
    expect(result.failures).toBe(outcome === "issued" ? 0 : 1);
  }
}
