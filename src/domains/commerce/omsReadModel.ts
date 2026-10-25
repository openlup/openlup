import type { SubscriptionCycleStatus } from "../subscription/types.js";
import {
adminCommerceOrderDetailResponseSchema,
type AdminCommerceOrderDetailResponse,
type OmsDeliveryContactResolution,
type OmsOrderDetail,
} from "./omsContracts.js";
import {
type OmsFulfillmentProviderStockCurrentRow,
type OmsInboundProviderEventRow
} from "./omsFulfillmentDebug.js";
import {
type OmsFulfillmentOperationRow,
type OmsFulfillmentOrderRow,
type OmsOmnipackDispatchRefRow,
type OmsOmnipackStatusEvidenceRow,
type OmsProviderAttemptRow,
type OmsReleasedProviderExceptionHoldRow,
type OmsShipmentExternalRefRow,
} from "./omsFulfillmentSummary.js";
import {
mapPet,
type OmsActionAvailabilityFlags
} from "./omsReadModelHelpers.js";
import type { OmsAccountingInvoiceRow,OmsAccountingOutboxRow,OmsAddressRow,OmsCommunicationDeliveryRow,OmsCustomerRow,OmsHoldRow,OmsInventoryReservationRow,OmsOperationRow,OmsOrderItemRow,OmsOrderRow,OmsPaymentAttemptRow,OmsPaymentIntentRow,OmsPaymentTransitionRow,OmsPetRow } from "./omsReadModelRows.js";

export { buildOmsOrderListResponse } from "./omsReadModelList.js";
export type { OmsAccountingInvoiceRow,OmsAccountingOutboxRow,OmsAddressRow,OmsCommunicationDeliveryRow,OmsCustomerRow,OmsHoldRow,OmsInventoryReservationRow,OmsOperationRow,OmsOrderItemRow,OmsOrderRow,OmsPaymentAttemptRow,OmsPaymentIntentRow,OmsPaymentTransitionRow,OmsPetRow } from "./omsReadModelRows.js";


import { buildOmsOrderDetailResponse as buildNeutral } from "@openlup/platform/commerce/server";
import { referenceOmsProjections,toNeutralInvoice } from "./omsReferenceBinding.js";
export function buildOmsOrderDetailResponse(input: {
  order: OmsOrderRow;
  paymentIntent: OmsPaymentIntentRow | null;
  paymentAttempts: OmsPaymentAttemptRow[];
  paymentTransitions: OmsPaymentTransitionRow[];
  holds: OmsHoldRow[];
  operations: OmsOperationRow[];
  customer?: OmsCustomerRow | null;
  pet?: OmsPetRow | null;
  shippingAddress?: OmsAddressRow | null;
  billingAddress?: OmsAddressRow | null;
  accountingInvoice?: OmsAccountingInvoiceRow | null;
  accountingOutbox?: OmsAccountingOutboxRow[];
  communicationDeliveries?: OmsCommunicationDeliveryRow[];
  orderItems?: OmsOrderItemRow[];
  inventoryReservations?: OmsInventoryReservationRow[];
  fulfillmentOrders?: OmsFulfillmentOrderRow[]; fulfillmentOperations?: OmsFulfillmentOperationRow[];
  supersededFulfillmentOrders?: OmsFulfillmentOrderRow[];
  shipmentExternalRefs?: OmsShipmentExternalRefRow[]; providerAttempts?: OmsProviderAttemptRow[];
  omnipackDispatchRefs?: OmsOmnipackDispatchRefRow[]; omnipackStatusEvidence?: OmsOmnipackStatusEvidenceRow[];
  releasedProviderExceptionHolds?: OmsReleasedProviderExceptionHoldRow[];
  fulfillmentHealth?: OmsOrderDetail["fulfillmentHealth"];
  inboundProviderEvents?: OmsInboundProviderEventRow[];
  providerStockCurrent?: OmsFulfillmentProviderStockCurrentRow[];
  subscriptionCycleStatus: SubscriptionCycleStatus | null;
  subscriptionCyclePaidAt?: string | null;
  subscriptionNextCycleAt?: string | null;
  actionFlags?: OmsActionAvailabilityFlags;
  deliveryContactResolution?: OmsDeliveryContactResolution;
}): AdminCommerceOrderDetailResponse {

  return adminCommerceOrderDetailResponseSchema.parse(buildNeutral({ ...input, identityExtras: { pet: mapPet(input.pet ?? null) }, accountingInvoice: toNeutralInvoice(input.accountingInvoice ?? null), providerDispatchRefs: input.omnipackDispatchRefs, providerStatusEvidence: input.omnipackStatusEvidence, projections: referenceOmsProjections } as Parameters<typeof buildNeutral>[0]));
}
