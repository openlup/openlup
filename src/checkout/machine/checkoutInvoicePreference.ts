import type { CheckoutRequest } from "@/domains/commerce/checkoutContracts";

import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";

export function buildCheckoutInvoicePreference(
  data: ConfiguratorFormData,
): CheckoutRequest["invoicePreference"] | undefined | null {
  if (!data.businessInvoice.requested) return undefined;
  const accepted = data.businessInvoice.acceptedData;
  if (!accepted || data.businessInvoice.lookupStatus !== "found") return null;
  return {
    kind: "b2b_vat",
    companyName: accepted.companyName,
    taxId: accepted.taxId,
    address: accepted.address,
    email: data.email,
    contactName: `${data.firstName} ${data.lastName}`.trim(),
  };
}
