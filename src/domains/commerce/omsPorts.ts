export { CommerceOmsConflictError, CommerceOmsInvalidResponseError, CommerceOmsPersistenceError, CommerceOmsUnsupportedCurrencyError, OMS_REPLACEMENT_COMMAND_REFUSALS, OMS_REPLACEMENT_REFUSALS, OMS_REPLACEMENT_RESERVATION_REFUSALS, readOmsReplacementRefusal, UNSPECIFIED_REPLACEMENT_REFUSAL } from "@openlup/platform/commerce";
export type { CommerceOmsHoldPort,OmsReplacementRefusal } from "@openlup/platform/commerce/contracts";
import { assertOmsOrderRowCurrency as assertCurrency } from "@openlup/platform/commerce";
import type { AdminCommerceOrderDetailRequest,AdminCommerceOrderDetailResponse,AdminCommerceOrdersListRequest,AdminCommerceOrdersListResponse } from "./omsContracts.js";
import { referenceOmsCurrency } from "./omsReferenceBinding.js";
export interface CommerceOmsReadPort { listOrders(request: AdminCommerceOrdersListRequest): Promise<AdminCommerceOrdersListResponse>; getOrderDetail(request: AdminCommerceOrderDetailRequest): Promise<AdminCommerceOrderDetailResponse | null> }
export function assertOmsOrderRowCurrency(rows: ReadonlyArray<{ id: string; currency: string }>): void { assertCurrency(rows, referenceOmsCurrency); }
