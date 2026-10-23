import { expect, expectTypeOf, it, vi } from "vitest";
import * as contracts from "../../src/invoicing/contracts/index.js";
import * as runtime from "../../src/invoicing/index.js";
import type { InvoiceCapabilities, InvoiceIdentity, InvoiceReadbackResult, InvoiceWriteResult, InvoiceArtifactResult, InvoiceSettlementResult, InvoiceStorePort, InvoiceHostPorts, InvoiceProviderPort, InvoiceDiagnosticCode, InvoiceDocumentIdentity, InvoiceClearanceObservation, InvoiceFacts, InvoiceUnsupported, InvoiceSettlementPort, InvoiceSettlementItem, InvoiceProof, InvoiceDutyReadback } from "../../src/invoicing/contracts/index.js";
const { runInvoiceCorrectionJob, createInvoiceReversalHandlers } = runtime;

const capability: InvoiceCapabilities = {
  version: "invoicing.capabilities.v1", providerRef: "fiscal-a", fiscalScope: { scopeRef: "host-scope", version: "v1" },
  policies: { identifierRef: "identifier-v1", taxRef: "tax-v1", roundingRef: "rounding-v1" },
  documentKinds: ["host-document"], correctionKinds: ["full_reversal"], numberingOwner: "provider", sellerTiming: "execution", defaultOff: true,
  operations: { issue: { supported: true }, correction: { supported: true }, recovery: { supported: true }, readback: { supported: true }, exactAbsence: { supported: true }, remoteVoid: { supported: false, reason: "not_implemented" }, artifact: { supported: false, reason: "host_required" }, clearance: { supported: false, reason: "host_required" }, settlement: { supported: false, reason: "host_required" }, companyLookup: { supported: false, reason: "host_required" } },
};

it("keeps contracts runtime-empty and selection default-off without invoking host effects", () => {
  expect(Object.keys(contracts)).toEqual([]);
  expect(Object.keys(runtime).sort()).toEqual(["runNativeInvoiceIssueJob", "createPostgresInvoiceStore", "INVOICING_MIGRATIONS", "collectInvoiceDuties", "createIndependentInvoiceDutyBinding", "allocateChargedGrossTotals", "allocateDiscountedGrossTotals", "createFulfillmentHandoffInvoiceHandler", "createNativeUnsupportedInvoicePorts", "createInvoiceReversalHandlers", "mapCanonicalIssueLines", "mapInvoiceClaimToProviderSnapshot", "readInvoiceCapabilities", "readInvoicePaymentEvidence", "runInvoiceAdapterConformance", "runInvoiceIssueJob", "runInvoiceCorrectionJob", "withAccountingInvoiceShadowTrigger", "withAutoDispatchAccountingInvoiceTrigger"].sort());
  for (const enabled of [undefined, false]) expect(runtime.readInvoiceCapabilities({ enabled, selection: { providerRef: capability.providerRef }, capability })).toMatchObject({ kind: "refused", code: "disabled", effectMayHaveSucceeded: false });
  for (const selection of [null, { providerRef: "other" }]) expect(runtime.readInvoiceCapabilities({ enabled: true, selection, capability })).toMatchObject({ kind: "refused", code: "selection_required" });
  expect(runtime.readInvoiceCapabilities({ enabled: true, selection: { providerRef: capability.providerRef }, capability: null })).toMatchObject({ kind: "refused", code: "selection_required" });
  expect(runtime.readInvoiceCapabilities({ enabled: true, selection: { providerRef: capability.providerRef }, capability })).toEqual({ kind: "ready", capability });
});

it("requires scoped complete absence, separates uncertainty and retains the SQL owed-duty envelope", () => {
  expectTypeOf<Extract<InvoiceReadbackResult, { kind: "absent" }>["evidence"]["scope"]>().toEqualTypeOf<InvoiceIdentity>();
  expectTypeOf<Extract<InvoiceReadbackResult, { kind: "absent" }>["evidence"]["complete"]>().toEqualTypeOf<true>();
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "unknown" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<true>();
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "unsupported" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<false>();
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "issued" }>["providerDocumentNumber"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Extract<InvoiceArtifactResult, { kind: "found" }>["artifact"]>().not.toHaveProperty("url");
  expectTypeOf<Extract<InvoiceSettlementResult, { kind: "recorded" }>["itemRef"]>().toEqualTypeOf<string>();
  expectTypeOf<Extract<Parameters<InvoiceStorePort["fail"]>[0], { kind: "absent" }>["evidence"]>().toEqualTypeOf<Extract<InvoiceReadbackResult, { kind: "absent" }>>();
  type IssueIdentity = Parameters<NonNullable<import("../../src/invoicing/contracts/index.js").InvoiceServicesOptions["provider"]>["issue"]>[0]["identity"];
  expectTypeOf<IssueIdentity["operation"]>().toEqualTypeOf<"issue">();
  expectTypeOf<IssueIdentity["parentProviderDocumentRef"]>().toEqualTypeOf<null>();
  type AbsentMoney = Extract<Awaited<ReturnType<InvoiceHostPorts["money"]["read"]>>, { kind: "absent" }>;
  expectTypeOf<AbsentMoney["evidence"]["scope"]>().toEqualTypeOf<Parameters<InvoiceHostPorts["money"]["read"]>[0]>();
  type Duty = Exclude<Awaited<ReturnType<InvoiceStorePort["readDuties"]>>, { kind: "unsupported" }>;
  const readback: Duty = { orderId: "order-a", captureFaults: [{ sourceId: "source-a", state: "resolved", attempts: 2, availableAt: "2026-10-22T12:00:00Z" }], duties: [{ dutyId: "duty-a", parentDutyId: null, documentId: null, state: "unsupported", attempts: 0, factAttempts: 2, diagnosticCode: "legacy_facts_unproved", createdAt: "2026-10-22T12:00:00Z", availableAt: "2026-10-22T12:01:00Z", leaseUntil: null }] };
  expect(readback.duties[0]).toMatchObject({ state: "unsupported", diagnosticCode: "legacy_facts_unproved" });
  expectTypeOf<Duty["duties"][number]["state"]>().toEqualTypeOf<"owed" | "blocked" | "claimed" | "unknown" | "issued" | "voided" | "unsupported" | "faulted">();
  type History = Extract<Awaited<ReturnType<InvoiceHostPorts["accountHistory"]["read"]>>, { kind: "found" }>;
  expectTypeOf<History["documents"][number]>().not.toHaveProperty("buyer");
  expectTypeOf<History["documents"][number]>().not.toHaveProperty("raw");
  expectTypeOf<History["documents"][number]>().toHaveProperty("parentDocumentRef");
});

it("preserves pinned durable outcomes and permits retryable only with before-send evidence", () => {
  type Install = Exclude<Awaited<ReturnType<InvoiceStorePort["installFacts"]>>, InvoiceUnsupported>;
  expectTypeOf<Install["status"]>().toEqualTypeOf<"owed" | "blocked" | "ready" | "processing" | "unknown" | "issued" | "voided" | "unsupported" | "faulted">();
  type Capture = Exclude<Awaited<ReturnType<InvoiceStorePort["captureDuty"]>>, InvoiceUnsupported>;
  expectTypeOf<Capture["status"]>().toEqualTypeOf<Install["status"]>();
  type Fail = Parameters<InvoiceStorePort["fail"]>[0];
  expectTypeOf<Extract<Fail, { kind: "retryable" }>["phase"]>().toEqualTypeOf<"before_send">();
  expectTypeOf<Extract<Fail, { kind: "retryable" }>["proof"]>().toEqualTypeOf<InvoiceProof | null>();
  expectTypeOf<Exclude<Awaited<ReturnType<InvoiceStorePort["fail"]>>, InvoiceUnsupported>["kind"]>().toEqualTypeOf<"recorded" | "voided" | "stale">();
  type Reversal = Exclude<Awaited<ReturnType<InvoiceStorePort["requestReversal"]>>, InvoiceUnsupported>;
  expectTypeOf<Extract<Reversal["kind"], "unsupported_recorded">>().toEqualTypeOf<"unsupported_recorded">();
  expectTypeOf<Reversal["dutyId"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<Reversal["replayed"]>().toEqualTypeOf<boolean | undefined>();
  type RefusedCode = Extract<InvoiceWriteResult, { kind: "refused" }>["code"];
  expectTypeOf<RefusedCode>().toEqualTypeOf<Extract<InvoiceDiagnosticCode, "blocked" | "retryable" | "missing_facts" | "identity_mismatch" | "parent_mismatch" | "money_mismatch">>();
  expectTypeOf<Extract<RefusedCode, "unknown" | "absent" | "uncertain_delivery" | "unsupported" | "host_binding_required" | "disabled" | "selection_required" | "faulted">>().toEqualTypeOf<never>();
  expectTypeOf<Awaited<ReturnType<InvoiceProviderPort["void"]>>>().toEqualTypeOf<InvoiceUnsupported>();
  expectTypeOf<InvoiceCapabilities["operations"]["remoteVoid"]["supported"]>().toEqualTypeOf<false>();
  expectTypeOf<Parameters<InvoiceStorePort["finishFacts"]>[0]["result"]["status"]>().toEqualTypeOf<"owed" | "ready" | "issued" | "voided" | "unsupported">();
  type AbsentMoney = Extract<Awaited<ReturnType<InvoiceHostPorts["money"]["read"]>>, { kind: "absent" }>;
  expectTypeOf<Extract<Parameters<InvoiceStorePort["preflight"]>[0], { status: "absent" }>["evidence"]>().toEqualTypeOf<AbsentMoney["evidence"]>();
  expectTypeOf<InvoiceFacts["payment"]["currency"]>().toEqualTypeOf<string>();
  expectTypeOf<InvoiceDutyReadback["orderId"]>().toEqualTypeOf<string>();
});

it("uses document scope for post-issue seams and requires native-compatible observation/settlement evidence", () => {
  expectTypeOf<Parameters<InvoiceHostPorts["artifacts"]["read"]>[0]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  expectTypeOf<Parameters<InvoiceHostPorts["artifacts"]["download"]>[0]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  expectTypeOf<Parameters<InvoiceHostPorts["artifacts"]["persist"]>[0]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  expectTypeOf<Parameters<InvoiceHostPorts["clearance"]["observe"]>[0]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  type Targets = Exclude<Awaited<ReturnType<InvoiceStorePort["listClearanceTargets"]>>, InvoiceUnsupported>;
  expectTypeOf<Targets[number]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  type Deliveries = Exclude<Awaited<ReturnType<InvoiceStorePort["claimDeliveries"]>>, InvoiceUnsupported>;
  expectTypeOf<Deliveries[number]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  expectTypeOf<Parameters<InvoiceStorePort["recordObservation"]>[0]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  expectTypeOf<Parameters<InvoiceStorePort["recordObservation"]>[0]["eventKind"]>().toEqualTypeOf<"clearance" | "artifacts" | "unsupported" | "provider_mismatch">();
  type Accepted = Extract<InvoiceClearanceObservation, { state: "accepted" }>;
  expectTypeOf<Accepted["reference"]>().toEqualTypeOf<string>();
  type LocalRequest = Exclude<Awaited<ReturnType<InvoiceStorePort["requestLocalDocument"]>>, InvoiceUnsupported>;
  expectTypeOf<Parameters<InvoiceStorePort["requestLocalDocument"]>[0]["providerRef"]>().toEqualTypeOf<string>();
  expectTypeOf<LocalRequest>().toEqualTypeOf<{ readonly kind: "requested"; readonly documentId: string; readonly invoiceRef: string; readonly status: string; readonly replayed: boolean }>();
  expectTypeOf<Parameters<InvoiceStorePort["settleDelivery"]>[0]["providerDocumentRef"]>().toEqualTypeOf<string>();
  expectTypeOf<Parameters<InvoiceStorePort["settleDelivery"]>[0]["retrySeconds"]>().toEqualTypeOf<number>();
  expectTypeOf<Extract<InvoiceArtifactResult, { kind: "absent" }>["evidence"]["scope"]["identity"]>().toEqualTypeOf<InvoiceDocumentIdentity>();
  expectTypeOf<Extract<InvoiceArtifactResult, { kind: "absent" }>>().not.toHaveProperty("proof");
  type Settlement = Parameters<InvoiceStorePort["settleDelivery"]>[0]["result"];
  expectTypeOf<Extract<Settlement, { kind: "unsupported" }>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<Settlement, { kind: "uncertain" }>["receiptRef"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Extract<Awaited<ReturnType<InvoiceHostPorts["artifacts"]["persist"]>>, { kind: "absent" }>>().toEqualTypeOf<never>();
  type AbsentItem = Extract<InvoiceSettlementResult, { kind: "absent" }>;
  expectTypeOf<AbsentItem["evidence"]["scope"]>().toEqualTypeOf<Parameters<InvoiceSettlementPort["resolve"]>[0]>();
  expectTypeOf<Parameters<InvoiceSettlementPort["record"]>[0]>().toEqualTypeOf<InvoiceSettlementItem>();
  type MissingCompany = Extract<Awaited<ReturnType<InvoiceHostPorts["registry"]["lookup"]>>, { kind: "not_found" }>;
  expectTypeOf<MissingCompany["identifier"]>().toEqualTypeOf<Parameters<InvoiceHostPorts["registry"]["lookup"]>[0]["identifier"]>();
});

it("keeps transient host read failures distinct from missing bindings, denial and empty receipts", () => {
  type Unknown = { readonly kind: "unknown"; readonly code: "unknown" };
  expectTypeOf<Extract<Awaited<ReturnType<InvoiceHostPorts["seller"]["read"]>>, { kind: "unknown" }>>().toEqualTypeOf<Unknown>();
  expectTypeOf<Extract<Awaited<ReturnType<InvoiceHostPorts["policy"]["decide"]>>, { kind: "unknown" }>>().toEqualTypeOf<Unknown>();
  expectTypeOf<Extract<Awaited<ReturnType<InvoiceHostPorts["fiscal"]["verify"]>>, { kind: "unknown" }>>().toEqualTypeOf<Unknown>();
  expectTypeOf<Extract<Awaited<ReturnType<InvoiceHostPorts["policy"]["receipts"]>>, { kind: "unknown" }>>().toEqualTypeOf<Unknown>();
  expectTypeOf<Extract<Awaited<ReturnType<InvoiceHostPorts["accountHistory"]["resolveDownload"]>>, { kind: "unknown" }>>().toEqualTypeOf<Unknown>();
});


it("reads the current seller before a duty exists and preserves the first-claim revision", () => {
  expectTypeOf<Parameters<InvoiceHostPorts["seller"]["read"]>[0]>().toEqualTypeOf<{ readonly orderId: string | null }>();
  type Seller = Extract<Awaited<ReturnType<InvoiceHostPorts["seller"]["read"]>>, { kind: "found" }>;
  expectTypeOf<Seller["revisionRef"]>().toEqualTypeOf<string>();
});

const fence = new Error("stale correction generation");
function subject(attemptCount = 2) {
  const trace: string[] = [];
  const claim = { outboxId: "saved-correction", attemptCount, providerInvoiceId: "parent", correctionReason: "full refund", payload: { providerCreateIdentity: "accounting-correction:saved-correction" } };
  const before = { lines: [{ name: "Saved item", totalGrossMinor: 1080 }], totalGrossMinor: 1080 };
  const receipt = { providerDocumentRef: "correction", providerDocumentNumber: null };
  const input = {
    createEnabled: true, providerEnabled: true,
    claim: vi.fn(async () => { trace.push("claim"); return [claim]; }),
    project: vi.fn((c: typeof claim) => { expect(c).toBe(claim); trace.push("project"); return before; }),
    create: vi.fn(async (snapshot: typeof before, options: { correctionReason: string; correctedProviderInvoiceId: string; correctionRef: string; recoveryLookupRequired: boolean }) => {
      expect(snapshot).toBe(before);
      expect(options).toEqual({ correctionReason: "full refund", correctedProviderInvoiceId: "parent", correctionRef: "accounting-correction:saved-correction", recoveryLookupRequired: attemptCount > 1 });
      trace.push("recover/create"); return receipt;
    }),
    finish: vi.fn(async (c: typeof claim, r: typeof receipt) => { expect(c).toBe(claim); expect(r).toBe(receipt); trace.push("finish"); }),
    isClaimFenceError: (error: unknown) => error === fence,
    fail: vi.fn(async (_c: typeof claim, _e: unknown, _retry: number) => { trace.push("fail"); }),
  };
  return { claim, before, receipt, input, trace };
}
it("carries positive BEFORE, durable correction/parent/reason and generation through create/recovery then finalize", async () => {
  for (const attempt of [1, 2]) {
    const s = subject(attempt);
    expect(await runInvoiceCorrectionJob(s.input)).toEqual({ ok: true, checked: 1, updated: 1, skipped: false, failures: 0 });
    expect(s.trace).toEqual(["claim", "project", "recover/create", "finish"]);
    expect(s.input.fail).not.toHaveBeenCalled();
  }
});
it("refuses missing identity and disabled work, preserves unknown recovery and fences both stale finalizers", async () => {
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "unknown" }>>().not.toMatchTypeOf<Awaited<ReturnType<Parameters<typeof runInvoiceCorrectionJob>[0]["create"]>>>();
  for (const scenario of ["disabled", "provider", "identity", "unknown", "parent", "stale-success", "stale-failure", "failure-error"] as const) {
    const s = subject(); const error = new Error(scenario);
    if (scenario === "disabled") s.input.createEnabled = false;
    if (scenario === "provider") s.input.providerEnabled = false;
    if (scenario === "identity") s.claim.payload.providerCreateIdentity = "";
    if (["unknown", "parent", "stale-failure", "failure-error"].includes(scenario)) s.input.create.mockRejectedValueOnce(error);
    if (scenario === "stale-success") s.input.finish.mockRejectedValueOnce(fence);
    if (scenario === "stale-failure") s.input.fail.mockRejectedValueOnce(fence);
    if (scenario === "failure-error") s.input.fail.mockRejectedValueOnce(error);
    if (scenario === "failure-error") { await expect(runInvoiceCorrectionJob(s.input)).rejects.toBe(error); continue; }
    const result = await runInvoiceCorrectionJob(s.input);
    expect(result.updated).toBe(0);
    if (scenario === "disabled" || scenario === "provider") expect(s.input.claim).not.toHaveBeenCalled();
    else expect(result.failures).toBe(1);
    if (scenario === "identity") { expect(s.input.project).not.toHaveBeenCalled(); expect(s.input.create).not.toHaveBeenCalled(); }
    if (scenario === "stale-success") expect(s.input.fail).not.toHaveBeenCalled();
    if (scenario === "unknown" || scenario === "parent" || scenario === "stale-failure") {
      expect(s.input.finish).not.toHaveBeenCalled();
      expect(s.input.fail).toHaveBeenCalledWith(s.claim, error, 600);
      expect(s.input.create).toHaveBeenCalledTimes(1);
    }
  }
});

it("preserves reversal adapter/writer outcomes, timeout and the RPC action", async () => {
  const row = { id: "saved-event", payload: { orderId: "saved-order" } };
  const request = { idempotencyKey: "saved-key", orderId: "saved-order", reason: "order_refunded" };
  const adapt = vi.fn((_row: typeof row): { kind: "ready"; request: typeof request } | { kind: "invalid_payload" } => ({ kind: "ready", request }));
  const write = vi.fn(async (_request: typeof request): Promise<{ action: string; invoice: { status: string } | null }> => ({ action: "voided", invoice: { status: "voided" } }));
  const input = { enabled: true, events: [{ eventType: "saved.refund", adapt }], request: write };
  const handlers = createInvoiceReversalHandlers(input);
  expect(handlers).toHaveLength(1);
  expect(handlers[0]).toMatchObject({ eventType: "saved.refund", timeoutMs: 10_000 });
  for (const [action, status] of [["voided", "voided"], ["correction_requested", "correction_requested"], ["corrected", "corrected"], ["no_invoice", null]]) {
    write.mockResolvedValueOnce({ action: action!, invoice: status ? { status } : null });
    expect(await handlers[0]!.handle(row)).toEqual({ kind: "processed", detail: { accountingReversalAction: action, invoiceStatus: status ?? "no_invoice" } });
    expect(adapt).toHaveBeenLastCalledWith(row); expect(write).toHaveBeenLastCalledWith(request);
  }
  adapt.mockReturnValueOnce({ kind: "invalid_payload" }); write.mockClear();
  expect(await handlers[0]!.handle(row)).toEqual({ kind: "discard", reason: "accounting_reversal_payload_invalid" });
  expect(write).not.toHaveBeenCalled();
  write.mockRejectedValueOnce(new Error("x".repeat(350)));
  expect(await handlers[0]!.handle(row)).toEqual({ kind: "retry", reason: "x".repeat(300) });
  expect(createInvoiceReversalHandlers({ ...input, enabled: false })).toEqual([]);
});
