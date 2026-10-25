import type { SubscriptionCycleStatus } from "../subscription/types.js";
import { adminCommerceOrdersListResponseSchema,type AdminCommerceOrdersListResponse,type AdminOmsOrderSearchMatch,type AdminOmsOrderListItem as OmsOrderListItem } from "./omsContracts.js";
import type {
OmsFulfillmentOperationRow,
OmsFulfillmentOrderRow,
OmsOmnipackDispatchRefRow,
OmsOmnipackStatusEvidenceRow,
OmsReleasedProviderExceptionHoldRow,
OmsShipmentExternalRefRow,
} from "./omsFulfillmentSummary.js";
import type { OmsAccountingInvoiceRow,OmsAccountingOutboxRow,OmsCustomerRow,OmsInventoryReservationRow,OmsOrderItemRow,OmsOrderRow,OmsPaymentAttemptRow,OmsPaymentIntentRow,OmsPetRow } from "./omsReadModelRows.js";


import { buildOmsOrderListResponse as buildNeutral } from "@openlup/platform/commerce";
import { mapPet } from "./omsReadModelHelpers.js";
import { referenceOmsProjections,toNeutralInvoice } from "./omsReferenceBinding.js";
export function buildOmsOrderListResponse(input: {
  orders: OmsOrderRow[];
  paymentIntents: OmsPaymentIntentRow[];
  paymentAttempts?: OmsPaymentAttemptRow[];
  activeHoldCounts: Record<string, number>;
  activeHoldReasons?: Record<string, OmsOrderListItem["activeHoldReasons"]>;
  fulfillmentHealthDigests?: Record<string, OmsOrderListItem["fulfillmentHealthDigest"]>;
  customers?: OmsCustomerRow[];
  pets?: OmsPetRow[];
  orderItems?: OmsOrderItemRow[];
  inventoryReservations?: OmsInventoryReservationRow[];
  fulfillmentOrders?: OmsFulfillmentOrderRow[];
  fulfillmentOperations?: OmsFulfillmentOperationRow[];
  shipmentExternalRefs?: OmsShipmentExternalRefRow[];
  omnipackDispatchRefs?: OmsOmnipackDispatchRefRow[];
  omnipackStatusEvidence?: OmsOmnipackStatusEvidenceRow[];
  releasedProviderExceptionHolds?: OmsReleasedProviderExceptionHoldRow[];
  accountingInvoices?: OmsAccountingInvoiceRow[];
  accountingOutbox?: OmsAccountingOutboxRow[];
  subscriptionCycleStatuses?: Record<string, SubscriptionCycleStatus | null>;
  searchMatches?: Record<string, AdminOmsOrderSearchMatch>;
  summaryCounts?: AdminCommerceOrdersListResponse["summaryCounts"];
  summaryTotals?: AdminCommerceOrdersListResponse["summaryTotals"];
  totalCount: number;
  page: number;
  pageSize: number;
}): AdminCommerceOrdersListResponse {

  return adminCommerceOrdersListResponseSchema.parse(buildNeutral({ ...input, identityExtras: Object.fromEntries(input.orders.map(order => [order.id, { pet: mapPet((input.pets ?? []).find(pet => pet.id === order.pet_id) ?? null) }])), accountingInvoices: input.accountingInvoices?.map(invoice => toNeutralInvoice(invoice)!), providerDispatchRefs: input.omnipackDispatchRefs, providerStatusEvidence: input.omnipackStatusEvidence, projections: referenceOmsProjections } as Parameters<typeof buildNeutral>[0]));
}
