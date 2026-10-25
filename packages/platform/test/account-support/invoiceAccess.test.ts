import { expect, it, vi } from "vitest";
import { createInvoiceAccess, downloadOwnedInvoicePdf, deriveCustomerDocumentDeliveryStatus } from "../../src/account-support/index.js";
import type { InvoiceOwnerAccessPort } from "../../src/account-support/index.js";

const document = {
  documentRef: "child",
  invoiceRef: "parent",
  parentDocumentRef: "parent",
  role: "correction" as const,
  status: "issued",
  issuedAt: null,
  clearance: null,
  documentKind: null,
  artifact: "correction" as const,
  providerDocumentNumber: null,
  totalGrossMinor: -50,
  currency: "EUR",
  emailState: "not_requested" as const,
  isCurrent: true,
  createdAt: "2030-01-01",
  downloadAvailable: true
};

it(
  "delegates M09 correction lineage, signed money and authorized PDF metadata",
  async () => {
    const identity = {
      providerRef: "host",
      documentRef: "child",
      providerDocumentRef: "remote-child",
      orderRef: "order-o",
      invoiceRef: "parent",
      parentProviderDocumentRef: "remote-parent"
    };
    const accountHistory: InvoiceOwnerAccessPort = {
      read: vi.fn<InvoiceOwnerAccessPort["read"]>().mockResolvedValue({ kind: "found", accountRef: "a", orderId: "o", documents: [document] }),
      resolveDownload: async () => ({
        kind: "authorized",
        identity,
        artifactRef: "artifact-child",
        fileName: "child.pdf",
        parentDocumentRef: "parent"
      })
    };
    const content = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const download = vi.fn(async () => ({ kind: "downloaded" as const, content, contentType: "application/pdf" as const }));
    const access = createInvoiceAccess({ accountHistory, artifacts: { download } });
    expect(await access.history({ accountRef: "a", orderId: "o" })).toMatchObject({
      kind: "found",
      documents: [{ totalGrossMinor: -50, documentRef: "child", parentDocumentRef: "parent" }]
    });
    expect(await access.download({ accountRef: "a", orderId: "o", documentRef: "child" })).toEqual({
      kind: "downloaded",
      content,
      contentType: "application/pdf",
      fileName: "child.pdf",
      parentDocumentRef: "parent"
    });
    expect(download).toHaveBeenCalledExactlyOnceWith({ identity, artifactRef: "artifact-child" });
    expect(accountHistory.read).toHaveBeenCalledTimes(2);

  }
);
const unsupported = { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } as const;
const unknown = { kind: "unknown", code: "unknown" } as const;
const denied = { kind: "denied" } as const;
const request = { accountRef: "a", orderId: "o", documentRef: "child" };
const owned = { kind: "found", accountRef: "a", orderId: "o", documents: [document] } as const;
it.each([
  { name: "unbound history", result: undefined, expected: unsupported },
  { name: "denied history", result: denied, expected: denied },
  { name: "unknown history", result: unknown, expected: unknown },
  { name: "unsupported history", result: unsupported, expected: unsupported },
  { name: "thrown history", result: new Error("unreadable"), expected: unknown }
])("retains history outcome: $name", async ({ result, expected }) => {
  const read = vi.fn<InvoiceOwnerAccessPort["read"]>();
  if (result instanceof Error) read.mockRejectedValue(result);
  else if (result) read.mockResolvedValue(result);
  expect(await createInvoiceAccess(result ? { accountHistory: { read, resolveDownload: vi.fn() } } : {}).history(request)).toEqual(expected);
});
it.each([
  { name: "unbound owned history", result: undefined, expected: unsupported },
  { name: "denied owned history", result: denied, expected: denied },
  { name: "unknown owned history", result: unknown, expected: unknown },
  { name: "unsupported owned history", result: unsupported, expected: unsupported },
  { name: "thrown owned history", result: new Error("unreadable"), expected: unknown },
  { name: "foreign document", result: { ...owned, documents: [{ ...document, documentRef: "foreign" }] }, expected: denied },
  { name: "unknown document", result: { ...owned, documents: [] }, expected: denied },
  { name: "foreign account", result: { ...owned, accountRef: "other" }, expected: denied },
  { name: "foreign order", result: { ...owned, orderId: "other" }, expected: denied }
])("binds download before ticket or artifact IO: $name", async ({ result, expected }) => {
  const read = vi.fn<InvoiceOwnerAccessPort["read"]>();
  if (result instanceof Error) read.mockRejectedValue(result);
  else if (result) read.mockResolvedValue(result);
  // A permissive resolver must never bypass the history gate.
  const resolveDownload = vi.fn<InvoiceOwnerAccessPort["resolveDownload"]>().mockResolvedValue({
    kind: "authorized", identity: {
      providerRef: "host", documentRef: "child", providerDocumentRef: "remote-child",
      orderRef: "another-order", invoiceRef: "another-invoice", parentProviderDocumentRef: null
    }, artifactRef: "foreign-artifact", fileName: "foreign.pdf", parentDocumentRef: null
  });
  const download = vi.fn(async (): Promise<never> => { throw new Error("must_not_download"); });
  const access = createInvoiceAccess({ accountHistory: result ? { read, resolveDownload } : undefined, artifacts: { download } });
  expect(await access.download(request)).toEqual(expected);
  if (result) expect(read).toHaveBeenCalledExactlyOnceWith({ accountRef: "a", orderId: "o" });
  else expect(read).not.toHaveBeenCalled();
  expect(resolveDownload).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});
it("retains a denied owner ticket after successful history binding", async () => {
  const download = vi.fn(async (): Promise<never> => { throw new Error("must_not_read"); });
  expect(await createInvoiceAccess({ accountHistory: {
    read: async () => owned, resolveDownload: async () => denied
  }, artifacts: { download } }).download(request)).toEqual(denied);
  expect(download).not.toHaveBeenCalled();
});
it("refuses a missing legacy ticket before artifact IO", async () => {
  const download = vi.fn(async (): Promise<never> => { throw new Error("must_not_read"); });
  expect(await downloadOwnedInvoicePdf({ resolve: async () => null, download })).toEqual(denied);
  expect(download).not.toHaveBeenCalled();
});
it("retains provider-accepted document delivery status", () => {
    expect(deriveCustomerDocumentDeliveryStatus({
      blockedReason: null,
      status: "issued",
      documentKind: null,
      ksefStatus: null,
      emailStatus: "sent",
      outboxStatus: null,
      downloadAvailable: true
    })).toBe("email_provider_accepted");
});

// Donor customerInvoiceDocumentStatus.ts: correction > failure > clearance > email > PDF.
it.each([
  { name: "blocked overrides failures", patch: { blockedReason: "review", emailStatus: "failed" }, expected: "requires_correction" },
  ...["rejected", "voided", "cancelled"].map(status => ({ name: `invoice ${status}`, patch: { status, emailStatus: "failed" }, expected: "requires_correction" })),
  { name: "rejected clearance", patch: { ksefStatus: " REJECTED ", emailStatus: "failed" }, expected: "requires_correction" },
  { name: "failed email before clearance", patch: { emailStatus: " FAILED ", documentKind: "b2b_vat" }, expected: "delivery_failed" },
  ...["failed", "uncertain", "cancelled"].map(outboxStatus => ({ name: `outbox ${outboxStatus}`, patch: { outboxStatus, emailStatus: "sent", documentKind: "b2b_vat" }, expected: "delivery_failed" })),
  { name: "clearance before accepted email", patch: { documentKind: "b2b_vat", emailStatus: "sent" }, expected: "ksef_pending" },
  ...["accepted", "not_required"].map(ksefStatus => ({ name: `clearance ${ksefStatus}`, patch: { documentKind: "b2b_vat", ksefStatus }, expected: "pdf_ready" })),
  { name: "provider accepted alias", patch: { emailStatus: " PROVIDER_ACCEPTED " }, expected: "email_provider_accepted" },
  { name: "succeeded outbox before pending email", patch: { outboxStatus: "succeeded", emailStatus: "pending" }, expected: "email_provider_accepted" },
  { name: "pending email before PDF", patch: { emailStatus: "pending" }, expected: "email_pending" },
  ...["pending", "processing"].map(outboxStatus => ({ name: `outbox ${outboxStatus}`, patch: { outboxStatus }, expected: "email_pending" })),
  { name: "PDF fallback", patch: {}, expected: "pdf_ready" },
  { name: "unavailable PDF", patch: { downloadAvailable: false }, expected: "not_ready" }
])("sweeps document delivery: $name", ({ patch, expected }) => expect(deriveCustomerDocumentDeliveryStatus({
  blockedReason: null, status: null, documentKind: null, ksefStatus: null, emailStatus: null, outboxStatus: null,
  downloadAvailable: true, ...patch
})).toBe(expected));
it.each(["owned"])("sweeps legacy PDF success: %s", async ticket => {
  const content = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const download = vi.fn(async () => ({ content, contentType: "application/pdf", fileName: "owned.pdf" }));
  expect(await downloadOwnedInvoicePdf({ resolve: async () => ticket, download })).toEqual({ kind: "downloaded", ticket, pdf: { content,
    contentType: "application/pdf", fileName: "owned.pdf" } });
  expect(download).toHaveBeenCalledExactlyOnceWith(ticket);
});
