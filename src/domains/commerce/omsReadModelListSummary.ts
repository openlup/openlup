import { summarizeOmsListOrders as summarize } from "@openlup/platform/commerce";
import type { AdminCommerceOrdersListResponse } from "./omsContracts.js";
import { referenceOmsProjections } from "./omsReferenceBinding.js";
export function summarizeOmsListOrders(orders: AdminCommerceOrdersListResponse["orders"]): AdminCommerceOrdersListResponse["summaryCounts"] {
const { providerDispatchedNotPicked, ...rest } = summarize(orders as Parameters<typeof summarize>[0], referenceOmsProjections); return { ...rest, omnipackDispatchedNotPicked: providerDispatchedNotPicked ?? 0 };
}
