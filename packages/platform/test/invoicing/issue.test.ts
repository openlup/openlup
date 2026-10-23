import { expect, expectTypeOf, it, vi } from "vitest";
import type { InvoiceWriteResult } from "../../src/invoicing/contracts/index.js";
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
    if (stage === "disabled" || stage === "missing") {
      expect(result).toMatchObject({ skipped: true, reason: stage === "disabled" ? "create_disabled" : "provider_disabled" });
      expect(s.input.claim).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: false, failures: 1 });
    }
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
