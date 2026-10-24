import { expect, it, vi } from "vitest";
import { createInvoiceReadModel, resolveInvoiceDocumentHistory } from "../../src/invoicing/index.js";
import type { InvoiceHostPorts } from "../../src/invoicing/contracts/index.js";

it("retains donor original/correction/replacement chronology, currency and email state through neutral columns", () => {
  const base = { id: "base-a", order_id: "order-a", invoice_ref: "INV-1", status: "corrected", provider_kind: "fiscal-a", provider_document_ref: "external-a", provider_document_number: "INV/1", total_gross_minor: 120, currency: "XXX", created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-21T10:00:00Z", correction_status: "issued", metadata: { correctionProviderDocumentRef: "correction-a", correctionProviderDocumentNumber: "COR/1" } };
  const history = resolveInvoiceDocumentHistory({ invoices: [
    { ...base, id: "replacement-a", status: "issued", correction_of_invoice_id: "base-a", provider_document_ref: "external-b", invoice_ref: "INV-2", metadata: {}, created_at: "2026-10-22T10:00:00Z" }, base,
  ], operations: [{ invoice_id: "base-a", operation: "provider_email_sent", payload: { providerDocumentRef: "correction-a" } }] });
  expect(history.documents.map(row => [row.role, row.providerDocumentRef, row.currency, row.totalGrossMinor])).toEqual([
    ["original", "external-a", "XXX", 120], ["correction", "correction-a", "XXX", null], ["replacement", "external-b", "XXX", 120],
  ]);
  expect(history.current?.invoiceId).toBe("replacement-a");
  expect(history.documents[1]).toMatchObject({ parentDocumentRef: "invoice:base-a", emailState: "provider_accepted" });
});

it("denies history for a different order with the same account", async () => {
  const model = createInvoiceReadModel({ accountHistory: {
    read: async () => ({ kind: "found", accountRef: "owner-a", orderId: "order-b", documents: [] }),
    resolveDownload: async () => ({ kind: "denied" }),
  } });
  expect(await model.history({ accountRef: "owner-a", orderId: "order-a" })).toEqual({ kind: "denied" });
});

it("denies a different document ticket before artifact read or bytes", async () => {
  const download = vi.fn();
  const model = createInvoiceReadModel({ accountHistory: {
    read: async () => ({ kind: "denied" }),
    resolveDownload: async () => ({ kind: "authorized", identity: { providerRef: "fiscal-a", documentRef: "doc-b",
      providerDocumentRef: "external-a", orderRef: "order-ref-a", invoiceRef: "INV-1", parentProviderDocumentRef: null },
      artifactRef: "fiscal-a:invoice:external-a:pdf", fileName: "INV-1.pdf", parentDocumentRef: null }),
  }, artifacts: { download } });
  expect(await model.download({ accountRef: "owner-a", orderId: "order-a", documentRef: "doc-a" })).toEqual({ kind: "denied" });
  expect(download).not.toHaveBeenCalled();
});

it("preserves owner-bound native child correction lineage and negative totals, while projecting only safe fields; missing parity is typed unsupported", async () => {
  const document = { documentRef: "child-a", invoiceRef: "COR-1", parentDocumentRef: "parent-a", role: "correction", status: "issued", issuedAt: "2026-10-22T12:00:00Z", clearance: null, documentKind: "correction", artifact: "correction", providerDocumentNumber: "COR/1", totalGrossMinor: -120, currency: "XXX", emailState: "not_requested", isCurrent: true, createdAt: "2026-10-22T12:00:00Z", downloadAvailable: false, raw: { secret: "forbidden" }, signedUrl: "https://example.invalid/private" } as const;
  const accountHistory: InvoiceHostPorts["accountHistory"] = {
    read: async input => ({ kind: "found", ...input, documents: [document] }),
    resolveDownload: async () => ({ kind: "denied" }),
  };
  const model = createInvoiceReadModel({ accountHistory });
  const result = await model.history({ accountRef: "owner-a", orderId: "order-a" });
  expect(result).toMatchObject({ kind: "found", documents: [{ parentDocumentRef: "parent-a", totalGrossMinor: -120, currency: "XXX", downloadAvailable: false }] });
  expect(JSON.stringify(result)).not.toMatch(/secret|signedUrl|https:/);
  expect(await createInvoiceReadModel().history({ accountRef: "owner-a", orderId: "order-a" })).toEqual({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false });
  expect(await createInvoiceReadModel().readDuties("order-a")).toMatchObject({ kind: "unsupported", code: "host_binding_required" });
  const crossed = createInvoiceReadModel({ accountHistory: { ...accountHistory, read: async () => ({ kind: "found", accountRef: "other-owner", orderId: "order-a", documents: [document] }) } });
  expect(await crossed.history({ accountRef: "owner-a", orderId: "order-a" })).toEqual({ kind: "denied" });
});

it("denies owner/operator access before queries or PDF and rejects transient URL identities and bad PDF bytes", async () => {
  const download = vi.fn(async () => ({ kind: "downloaded" as const, content: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf" }));
  const resolveDownload = vi.fn<InvoiceHostPorts["accountHistory"]["resolveDownload"]>(async () => ({ kind: "denied" }));
  const model = createInvoiceReadModel({ accountHistory: { read: async () => ({ kind: "denied" }), resolveDownload }, artifacts: { download } });
  const input = { accountRef: "owner-a", orderId: "order-a", documentRef: "doc-a" };
  expect(await model.download(input)).toEqual({ kind: "denied" });
  expect(download).not.toHaveBeenCalled();
  const read = vi.fn();
  expect(await model.operator({ authorize: async () => false, read })).toEqual({ kind: "denied" });
  expect(read).not.toHaveBeenCalled();
  const ticket = { kind: "authorized", identity: { providerRef: "fiscal-a", documentRef: "doc-a", providerDocumentRef: "external-a", orderRef: "order-ref-a", invoiceRef: "INV-1", parentProviderDocumentRef: null }, artifactRef: "fiscal-a:invoice:external-a:pdf", fileName: "INV-1.pdf", parentDocumentRef: null } as const;
  resolveDownload.mockResolvedValueOnce({ ...ticket, artifactRef: "https://example.invalid/signed" });
  expect(await model.download(input)).toEqual({ kind: "denied" });
  expect(download).not.toHaveBeenCalled();
  resolveDownload.mockResolvedValueOnce(ticket);
  download.mockResolvedValueOnce({ kind: "downloaded", content: new TextEncoder().encode("invalid"), contentType: "application/pdf" });
  expect(await model.download(input)).toEqual({ kind: "unknown", code: "unknown" });
  resolveDownload.mockResolvedValueOnce(ticket);
  expect(await model.download(input)).toMatchObject({ kind: "downloaded", fileName: "INV-1.pdf", parentDocumentRef: null });
});
