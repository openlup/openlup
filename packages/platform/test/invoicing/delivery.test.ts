import { expect, it, vi } from "vitest";
import { runInvoiceDeliveryJob, syncAcceptedInvoiceDocuments } from "../../src/invoicing/index.js";
import type { InvoiceStorePort, InvoiceHostPorts } from "../../src/invoicing/contracts/index.js";
import { proof, sqlCall, expectPinnedSqlOrder } from "./portFitFixtures.js";

type Claim = Exclude<Awaited<ReturnType<InvoiceStorePort["claimDeliveries"]>>, { kind: "unsupported" }>[number];
const claim: Claim = {
  token: "token-a", generation: 3,
  identity: { providerRef: "fiscal-a", documentRef: "document-a", providerDocumentRef: "external-a", orderRef: "order-a", invoiceRef: "invoice-a", parentProviderDocumentRef: null },
  providerDocumentRef: "external-a",
  delivery: { deliveryRef: "delivery-a", requestKey: " original:key ", attemptCount: 3, documentRef: "document-a", orderId: "order-id-a", orderRef: "order-a", invoiceRef: "invoice-a", providerDocumentRef: "external-a", clientRef: null, recipient: "buyer@example.invalid", source: null, providerDocumentNumber: null },
};
type Outcome = Awaited<ReturnType<InvoiceHostPorts["delivery"]["send"]>>;
const pdf = { content: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf" };
function binding(outcome: Outcome) {
  let state = "pending";
  const settle = vi.fn(async () => { state = "settled"; });
  const send = vi.fn(async () => outcome);
  const input = {
    enabled: true, providerEnabled: true, deliveryEnabled: true,
    claim: vi.fn(async () => state === "pending" ? [claim] : []),
    attemptCount: (row: Claim) => row.delivery.attemptCount,
    validate: vi.fn(), download: vi.fn(async () => pdf), filename: () => "host.pdf",
    send, failedBeforeSend: vi.fn(async () => undefined), terminalFailure: settle,
    uncertain: settle, accepted: settle, finalizeUncertain: settle,
  };
  return { input, send, settle };
}

it("validates before M04, preserves original keys, and never repeats uncertain send or acceptance plus lost local ACK", async () => {
  for (const lostAck of [false, true]) {
    const { input, send, settle } = binding(lostAck
      ? { kind: "provider_accepted", receiptRef: "message-a", proof }
      : { kind: "uncertain", code: "uncertain_delivery", receiptRef: null });
    if (lostAck) input.accepted = vi.fn(async () => { throw new Error("ACK lost"); });
    expect(await runInvoiceDeliveryJob(input)).toMatchObject({ failures: 1, updated: 0 });
    expect(send).toHaveBeenCalledWith(claim, { ...pdf, filename: "host.pdf" });
    expect(claim.delivery.requestKey).toBe(" original:key ");
    expect(settle).toHaveBeenCalledTimes(1);
    await runInvoiceDeliveryJob(input);
    expect(send).toHaveBeenCalledTimes(1);
    expect(input.failedBeforeSend).not.toHaveBeenCalled();
  }
  const { input, send } = binding({ kind: "provider_accepted", receiptRef: "message-a", proof });
  input.download.mockResolvedValueOnce({ ...pdf, content: new TextEncoder().encode("bad bytes") });
  await runInvoiceDeliveryJob(input);
  expect(send).not.toHaveBeenCalled();
  expect(input.failedBeforeSend).toHaveBeenCalledWith(claim, expect.any(Error), 900);
});

it("requires a terminal host binding before claiming and routes non-retryable refusals there", async () => {
  const { input, send, settle } = binding({ kind: "failed_before_send", retryable: false, code: "invalid_artifact" });
  expect(await runInvoiceDeliveryJob({ ...input, terminalFailure: undefined } as never)).toMatchObject({ reason: "host_binding_required", checked: 0 });
  expect(input.claim).not.toHaveBeenCalled();
  await runInvoiceDeliveryJob(input);
  expect(settle).toHaveBeenCalledWith(claim, { kind: "failed_before_send", retryable: false, code: "invalid_artifact" });
  expect(input.failedBeforeSend).not.toHaveBeenCalled();
  await runInvoiceDeliveryJob(input);
  expect(send).toHaveBeenCalledTimes(1);
});

it("accounts for every required delivery store input against pinned native SQL, including retry evidence and uncertain receipt hint", () => {
  const rows = [
    sqlCall("claimDeliveries", "191000_invoicing_document_effects", "invoicing_claim_deliveries", [
      ["p_limit", "input.limit"], ["p_visibility", "input.visibilitySeconds"], ["p_require_clearance", "input.requireClearance"], ["p_order_id", "input.orderId"],
    ] as const, {}),
    sqlCall("settleDelivery", "191000_invoicing_document_effects", "invoicing_settle_delivery", [
      ["p_delivery", "input.deliveryRef"], ["p_token", "input.token"], ["p_generation", "input.generation"],
      ["p_kind", "input.result.kind"], ["p_receipt", "input.result"], ["p_evidence", "input.result", "input.retrySeconds"],
    ] as const, { providerDocumentRef: "checked by the native store before settlement" }),
  ];
  for (const row of rows) expectPinnedSqlOrder(row.fixture, row.name, row.args.map(([name]) => name));
});

it("observes pending/rejected/not_submitted clearance and records status without downloading accepted artifacts", async () => {
  const record = vi.fn(); const download = vi.fn(); const recordStatus = vi.fn();
  const result = await syncAcceptedInvoiceDocuments({ targets: async () => ["pending", "rejected", "not_submitted"], observe: async status => status, recordStatus, accepted: status => status === "accepted", downloads: [download], record });
  expect(result).toMatchObject({ checked: 3, updated: 3, failures: 0 });
  expect(recordStatus.mock.calls.map(([target]) => target)).toEqual(["pending", "rejected", "not_submitted"]);
  expect(download).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
});

it("records accepted clearance before syncing every host attachment and durable provider reference", async () => {
  const trace: string[] = [];
  const result = await syncAcceptedInvoiceDocuments({ targets: async () => ["target"], observe: async () => "accepted", recordStatus: async () => { trace.push("status"); }, accepted: () => true,
    downloads: [async () => { trace.push("pdf"); return pdf; }, async () => { trace.push("structured"); return pdf; }, async () => { trace.push("receipt"); return pdf; }],
    record: async (target, status, documents) => { expect([target, status, documents.length]).toEqual(["target", "accepted", 3]); trace.push("record"); },
  });
  expect(result).toMatchObject({ updated: 1, failures: 0 });
  expect(trace).toEqual(["status", "pdf", "structured", "receipt", "record"]);
});

it("keeps per-target polling failures visible and never fabricates accepted artifacts when observer or download is unavailable", async () => {
  const record = vi.fn();
  const result = await syncAcceptedInvoiceDocuments({ targets: async () => ["unavailable", "bad-artifact", "pending"], observe: async target => { if (target === "unavailable") throw new Error("timeout"); return target === "pending" ? "pending" : "accepted"; }, recordStatus: async () => undefined, accepted: status => status === "accepted", downloads: [async () => { throw new Error("artifact unavailable"); }], record });
  expect(result).toEqual({ ok: false, checked: 3, updated: 1, skipped: false, failures: 2 });
  expect(record).not.toHaveBeenCalled();
});
