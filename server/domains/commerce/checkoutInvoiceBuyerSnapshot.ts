import type {
  ConfiguratorIntent,
} from "../../../src/domains/commerce/configuratorIntentContracts.js";
import {
  invoiceBuyerSnapshotSchema,
  type CheckoutInvoicePreference,
  type InvoiceBuyerSnapshot,
} from "../../../src/domains/commerce/checkoutContracts.js";

export function buildCheckoutInvoiceBuyerSnapshot(
  intent: ConfiguratorIntent,
  invoicePreference: CheckoutInvoicePreference,
): InvoiceBuyerSnapshot {
  if (invoicePreference.kind === "b2b_vat") {
    return invoiceBuyerSnapshotSchema.parse({
      name: invoicePreference.companyName,
      email: invoicePreference.email ?? intent.contact.email,
      taxId: invoicePreference.taxId,
      companyName: invoicePreference.companyName,
      source: "checkout_invoice_preference",
      address: {
        ...invoicePreference.address,
        source: "checkout_invoice_billing_address",
      },
    });
  }

  return invoiceBuyerSnapshotSchema.parse({
    name: `${intent.contact.firstName} ${intent.contact.lastName}`.trim(),
    email: intent.contact.email,
    taxId: null,
    companyName: null,
    source: "checkout_invoice_preference",
    address: {
      line1: intent.address.street,
      line2: null,
      city: intent.address.city,
      postalCode: intent.address.postalCode,
      country: intent.address.country,
      source: "checkout_shipping_address",
    },
  });
}
