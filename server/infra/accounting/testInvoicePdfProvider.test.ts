import { describe, expect, it } from "vitest";
import { createTestInvoicePdfProvider } from "./testInvoicePdfProvider.js";

describe("test invoice PDF provider", () => {
  it("generates a non-fiscal preview PDF", async () => {
    const result = await createTestInvoicePdfProvider().downloadInvoicePdf({
      invoiceId: "invoice-1",
      invoiceRef: "TEST-1",
      providerKind: "fakturownia_test",
      providerInvoiceId: "test_inv_ORDER-1",
      providerInvoiceNumber: "TEST/FV/2026/ORDER-1",
      fileName: "TEST-FV-2026-ORDER-1.pdf",
    });

    expect(result.contentType).toBe("application/pdf");
    expect(result.content.subarray(0, 8).toString("utf8")).toBe("%PDF-1.4");
    expect(result.content.toString("utf8")).toContain("NON-FISCAL TEST DOCUMENT");
    expect(result.content.toString("utf8")).toContain("No KSeF submission was made.");
  });
});
