import { describe, expect, it } from "vitest";
import { enrichBillingWithInvoiceBuyer } from "../../src/commerce/model/omsBillingInvoiceBuyer.js";

const baseBilling = {
  id: "addr-1",
  label: "Hidden configurator",
  line1: "Example Road 1",
  line2: null,
  city: "Example City",
  postalCode: "EXAMPLE-002",
  country: "XX",
  recipientName: null,
  contactPhone: null,
  companyName: null,
  taxId: null,
  deliveryNotes: null,
  courierInstructions: null,
} as NonNullable<ReturnType<typeof enrichBillingWithInvoiceBuyer>>;

describe("enrichBillingWithInvoiceBuyer (OMS-T10)", () => {
  it("returns null when there is no billing address", () => {
    expect(enrichBillingWithInvoiceBuyer(null, { invoiceBuyerSnapshot: { companyName: "X", taxId: "1" } })).toBeNull();
  });

  it("surfaces B2B companyName + taxId from invoiceBuyerSnapshot when the row lacks them", () => {
    const result = enrichBillingWithInvoiceBuyer(baseBilling, {
      invoiceBuyerSnapshot: { companyName: "Example Company", taxId: "TAX-EXAMPLE-001" },
    });
    expect(result?.companyName).toBe("Example Company");
    expect(result?.taxId).toBe("TAX-EXAMPLE-001");
  });

  it("does not overwrite company/taxId already present on the address row", () => {
    const withValues = { ...baseBilling, companyName: "Existing", taxId: "999" };
    const result = enrichBillingWithInvoiceBuyer(withValues, {
      invoiceBuyerSnapshot: { companyName: "Other", taxId: "111" },
    });
    expect(result?.companyName).toBe("Existing");
    expect(result?.taxId).toBe("999");
  });

  it("leaves billing unchanged when metadata has no usable snapshot", () => {
    expect(enrichBillingWithInvoiceBuyer(baseBilling, null)).toBe(baseBilling);
    expect(enrichBillingWithInvoiceBuyer(baseBilling, {})).toBe(baseBilling);
    expect(enrichBillingWithInvoiceBuyer(baseBilling, { invoiceBuyerSnapshot: { companyName: "  " } })).toBe(baseBilling);
  });
});
