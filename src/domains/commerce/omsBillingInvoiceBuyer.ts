import type { OmsOrderDetail } from "./omsContracts.js";

export function enrichBillingWithInvoiceBuyer(
  billing: OmsOrderDetail["billingAddress"],
  orderMetadata: Record<string, unknown> | null,
): OmsOrderDetail["billingAddress"] {
  if (!billing) return billing;
  const snapshot =
    orderMetadata && typeof orderMetadata === "object"
      ? (orderMetadata as { invoiceBuyerSnapshot?: unknown }).invoiceBuyerSnapshot
      : null;
  if (!snapshot || typeof snapshot !== "object") return billing;
  const buyer = snapshot as { companyName?: unknown; taxId?: unknown };
  const companyName =
    billing.companyName ?? (typeof buyer.companyName === "string" && buyer.companyName.trim() ? buyer.companyName : null);
  const taxId =
    billing.taxId ?? (typeof buyer.taxId === "string" && buyer.taxId.trim() ? buyer.taxId : null);
  if (companyName === billing.companyName && taxId === billing.taxId) return billing;
  return { ...billing, companyName, taxId };
}
