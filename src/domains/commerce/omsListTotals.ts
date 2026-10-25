export { CommerceOmsMixedCurrencyTotalsError } from "@openlup/platform/commerce";
import { summarizeOmsListTotals as summarize } from "@openlup/platform/commerce";
import type { AdminCommerceOrdersListResponse } from "./omsContracts.js";
import { referenceOmsCurrency } from "./omsReferenceBinding.js";
export function summarizeOmsListTotals(orders: AdminCommerceOrdersListResponse["orders"]): AdminCommerceOrdersListResponse["summaryTotals"] {
return summarize(orders as Parameters<typeof summarize>[0], referenceOmsCurrency);
}
