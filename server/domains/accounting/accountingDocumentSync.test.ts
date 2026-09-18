import { describe, expect, it, vi } from "vitest";
import { syncAcceptedKsefDocuments } from "./accountingDocumentSync.js";
import type { AccountingInvoiceRuntimePort, AccountingKsefPollTarget } from "../../../src/domains/accounting/ports.js";

describe("accounting document sync", () => {
  it("records accepted KSeF PDF, XML, and UPO metadata with deterministic provider refs", async () => {
    const port = {
      recordProviderDocumentSync: vi.fn(async () => undefined),
    } as unknown as AccountingInvoiceRuntimePort;
    const provider = {
      downloadInvoicePdf: vi.fn(async () => ({
        content: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
      })),
      downloadKsefAttachment: vi.fn(async (_providerInvoiceId: string, kind: "gov" | "gov_upo") => ({
        content: new TextEncoder().encode(`<${kind}/>`),
        contentType: "application/xml",
      })),
    };
    const target: AccountingKsefPollTarget = {
      invoiceId: "invoice-1",
      providerKind: "fakturownia",
      providerInvoiceId: "provider-123",
      providerInvoiceNumber: "FV/1/2026",
      ksefStatus: "pending",
    };

    await syncAcceptedKsefDocuments({
      port,
      provider,
      target,
      status: {
        ksefStatus: "accepted",
        ksefNumber: "KSEF-1",
        raw: { gov_status: "accepted" },
      },
    });

    expect(provider.downloadInvoicePdf).toHaveBeenCalledWith("provider-123");
    expect(provider.downloadKsefAttachment).toHaveBeenCalledWith("provider-123", "gov");
    expect(provider.downloadKsefAttachment).toHaveBeenCalledWith("provider-123", "gov_upo");
    expect(port.recordProviderDocumentSync).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: "invoice-1",
      providerKind: "fakturownia",
      providerEventId: "provider-123:ksef-documents:KSEF-1",
      eventType: "ksef.accepted",
      providerInvoiceId: "provider-123",
      providerInvoiceNumber: "FV/1/2026",
      ksefNumber: "KSEF-1",
      ksefStatus: "accepted",
      providerPdfRef: "fakturownia:invoice:provider-123:pdf",
      providerXmlRef: "fakturownia:invoice:provider-123:gov",
      providerUpoRef: "fakturownia:invoice:provider-123:gov_upo",
      payloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      payload: expect.objectContaining({
        documents: {
          pdf: { contentType: "application/pdf", bytes: 4 },
          xml: { contentType: "application/xml", bytes: 6 },
          upo: { contentType: "application/xml", bytes: 10 },
        },
      }),
    }));
  });
});
