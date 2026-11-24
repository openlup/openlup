import { describe, expect, it, vi } from "vitest";
import { createTestAccountingProvider } from "./testAccountingProvider.js";

describe("test accounting provider", () => {
  it("creates deterministic test invoice refs without network calls or KSeF submission", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createTestAccountingProvider();
    expect(provider).not.toHaveProperty("sendInvoiceEmail");

    await expect(provider.createInvoice({
      orderRef: "ORDER/123",
      issueDate: "2026-06-09",
      currency: "PLN",
      buyer: { name: "Client", email: "client@example.test", taxId: null },
      documentKind: "b2b_vat",
      governmentClearanceRequired: true,
      lines: [{ name: "Food", quantity: 1, unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" }],
    }, {
      recoveryLookupRequired: false,
    })).resolves.toMatchObject({
      providerInvoiceId: "test_inv_ORDER-123",
      providerInvoiceNumber: "TEST/FV/2026/ORDER-123",
      raw: {
        provider: "accounting_test",
        mode: "test",
        documentKind: "b2b_vat",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reports KSeF as not submitted in test mode", async () => {
    await expect(createTestAccountingProvider().getInvoiceKsefStatus?.("test_inv_ORDER-1")).resolves.toEqual({
      ksefStatus: "not_submitted",
      ksefNumber: null,
      raw: { provider: "accounting_test", mode: "test" },
    });
  });

  it("supports neutral custom prefixes and getGovernmentClearanceStatus", async () => {
    const provider = createTestAccountingProvider({ invoicePrefix: "TEST/INV", correctionPrefix: "TEST/CR" });
    const issued = await provider.createInvoice(
      {
        orderRef: "ORDER/999",
        issueDate: "2030-06-09",
        currency: "USD",
        buyer: { name: "Buyer", email: "buyer@example.test", taxId: null },
        documentKind: "b2c_named",
        governmentClearanceRequired: false,
        lines: [{ name: "Item", quantity: 1, unitNetMinor: 1000, unitGrossMinor: 1000, vatRate: "0" }],
      },
      { recoveryLookupRequired: false },
    );
    expect(issued.providerInvoiceNumber).toBe("TEST/INV/2030/ORDER-999");
    await expect(provider.getGovernmentClearanceStatus("test_inv_ORDER-999")).resolves.toEqual({
      status: "not_submitted",
      clearanceRef: null,
      raw: { provider: "accounting_test", mode: "test" },
    });
  });
});
