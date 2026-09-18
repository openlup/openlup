import { describe, expect, it, vi } from "vitest";
import { createFakturowniaAccountingDocumentProvider } from "./accountingDocumentProvider.js";

describe("Fakturownia accounting document provider adapter", () => {
  it("recovers an accepted invoice before retrying the provider create", async () => {
    const accepted = {
      providerInvoiceId: "invoice-1",
      providerInvoiceNumber: "FV/1/2026",
      raw: { id: 1 },
    };
    const client = clientStub({
      createInvoice: vi.fn(async () => accepted),
      findInvoiceByOid: vi.fn(async () => accepted),
    });
    const provider = createFakturowniaAccountingDocumentProvider(client);
    expect(provider).not.toHaveProperty("sendInvoiceEmail");

    await expect(provider.createInvoice(invoiceSnapshot(), {
      recoveryLookupRequired: false,
    })).resolves.toEqual(accepted);
    await expect(provider.createInvoice(invoiceSnapshot(), {
      recoveryLookupRequired: true,
    })).resolves.toEqual(accepted);

    expect(client.createInvoice).toHaveBeenCalledTimes(1);
    expect(client.findInvoiceByOid).toHaveBeenCalledOnce();
    expect(client.findInvoiceByOid).toHaveBeenCalledWith("ORDER-1");
  });

  it("creates once after a recovery lookup proves the OID is absent", async () => {
    const client = clientStub({ findInvoiceByOid: vi.fn(async () => null) });
    const provider = createFakturowniaAccountingDocumentProvider(client);

    await provider.createInvoice(invoiceSnapshot(), {
      recoveryLookupRequired: true,
    });

    expect(client.findInvoiceByOid).toHaveBeenCalledOnce();
    expect(client.createInvoice).toHaveBeenCalledOnce();
    expect(client.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      invoice: expect.objectContaining({ oid: "ORDER-1", oid_unique: "yes" }),
    }));
  });

  it("does not POST when a recovery lookup is unavailable", async () => {
    const client = clientStub({
      findInvoiceByOid: vi.fn(async () => {
        throw new Error("fakturownia_request_failed:503");
      }),
    });
    const provider = createFakturowniaAccountingDocumentProvider(client);

    await expect(provider.createInvoice(invoiceSnapshot(), {
      recoveryLookupRequired: true,
    })).rejects.toThrow("fakturownia_request_failed:503");
    expect(client.createInvoice).not.toHaveBeenCalled();
  });

  it("builds correction-to-zero requests through the correction API", async () => {
    const client = {
      createInvoice: vi.fn(),
      findInvoiceByOid: vi.fn(),
      createCorrection: vi.fn(async (payload: unknown) => ({
        providerInvoiceId: "correction-1",
        providerInvoiceNumber: "KOR/1/2026",
        raw: { payload },
      })),
      sendInvoiceEmail: vi.fn(),
      downloadInvoicePdf: vi.fn(),
      downloadKsefAttachment: vi.fn(),
      getInvoiceKsefStatus: vi.fn(),
    };
    const provider = createFakturowniaAccountingDocumentProvider(client);

    await expect(provider.createFullCorrection({
      orderRef: "ORDER-1",
      issueDate: "2026-06-26",
      currency: "PLN",
      buyer: {
        name: "Buyer",
        email: "buyer@example.test",
        taxId: null,
        address: { line1: "ul. Prosta 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
      },
      documentKind: "b2c_named",
      governmentClearanceRequired: false,
      // Line totals mirror the corrected document; the reconciled
      // totalGrossMinor wins over any unit-derived value.
      lines: [{
        name: "Food",
        quantity: 2,
        unitNetMinor: 500,
        unitGrossMinor: 540,
        totalNetMinor: 1000,
        totalGrossMinor: 1080,
        vatRate: "8",
      }],
    }, {
      correctionReason: "order_refunded",
      correctedProviderInvoiceId: "fv-1",
    })).resolves.toMatchObject({
      providerInvoiceId: "correction-1",
      providerInvoiceNumber: "KOR/1/2026",
    });

    expect(client.createCorrection).toHaveBeenCalledWith({
      invoice: expect.objectContaining({
        from_invoice_id: "fv-1",
        invoice_id: "fv-1",
        correction_reason: "order_refunded",
        buyer_name: "Buyer",
        buyer_email: "buyer@example.test",
        buyer_street: "ul. Prosta 1",
        buyer_post_code: "00-001",
        buyer_city: "Warszawa",
        buyer_country: "PL",
        positions: [expect.objectContaining({
          quantity: -2,
          total_price_gross: -10.8,
          correction_before_attributes: expect.objectContaining({ quantity: 2, total_price_gross: 10.8 }),
          correction_after_attributes: expect.objectContaining({ quantity: 0, total_price_gross: 0 }),
        })],
      }),
    });
    expect(client.createInvoice).not.toHaveBeenCalled();
  });

  it("derives correction-before totals from unit price times quantity for legacy lines", async () => {
    const client = {
      createInvoice: vi.fn(),
      findInvoiceByOid: vi.fn(),
      createCorrection: vi.fn(async () => ({
        providerInvoiceId: "correction-2",
        providerInvoiceNumber: "KOR/2/2026",
        raw: {},
      })),
      sendInvoiceEmail: vi.fn(),
      downloadInvoicePdf: vi.fn(),
      downloadKsefAttachment: vi.fn(),
      getInvoiceKsefStatus: vi.fn(),
    };
    const provider = createFakturowniaAccountingDocumentProvider(client);

    await provider.createFullCorrection({
      orderRef: "ORDER-2",
      issueDate: "2026-07-13",
      currency: "PLN",
      buyer: { name: "Buyer", email: "buyer@example.test", taxId: null },
      documentKind: "b2c_named",
      governmentClearanceRequired: false,
      lines: [{ name: "Food", quantity: 3, unitNetMinor: 1241, unitGrossMinor: 1340, vatRate: "8" }],
    }, {
      correctionReason: "order_refunded",
      correctedProviderInvoiceId: "fv-2",
    });

    expect(client.createCorrection).toHaveBeenCalledWith(expect.objectContaining({
      invoice: expect.objectContaining({
        positions: [expect.objectContaining({
          quantity: -3,
          total_price_gross: -40.2,
          correction_before_attributes: expect.objectContaining({ quantity: 3, total_price_gross: 40.2 }),
        })],
      }),
    }));
  });
});

function invoiceSnapshot() {
  return {
    orderRef: "ORDER-1",
    issueDate: "2026-07-16",
    currency: "PLN",
    buyer: { name: "Buyer", email: "buyer@example.test", taxId: null },
    lines: [{ name: "Food", quantity: 1, unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" }],
  };
}

function clientStub(overrides: Record<string, unknown> = {}) {
  return {
    createInvoice: vi.fn(async () => ({
      providerInvoiceId: "invoice-created",
      providerInvoiceNumber: "FV/CREATED/2026",
      raw: {},
    })),
    findInvoiceByOid: vi.fn(async () => null),
    createCorrection: vi.fn(),
    sendInvoiceEmail: vi.fn(),
    downloadInvoicePdf: vi.fn(),
    downloadKsefAttachment: vi.fn(),
    getInvoiceKsefStatus: vi.fn(),
    ...overrides,
  };
}
