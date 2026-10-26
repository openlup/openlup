import type { z } from "zod";
export function buildCheckoutInvoiceBuyerSnapshot<Buyer>(
  intent: { contact: { firstName: string; lastName: string; email: string }; address: { street: string; city: string; postalCode: string; country: string } },
  invoicePreference: { kind: "b2c_named" } | { kind: "b2b_vat"; companyName: string; email?: string; taxId?: string; address: object },
  schema: z.ZodType<Buyer>,
): Buyer {
  if (invoicePreference.kind === "b2b_vat") {
    return schema.parse({
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

  return schema.parse({
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
