import { referenceDebugSummary,referenceDispatchStepLabel,referenceUsesExternalStock } from "./omsFulfillmentDebug.js";
import { referenceDispatchLabel } from "./omsFulfillmentSummary.js";
import { referencePaymentMethodLabel } from "./omsPaymentMethodSummary.js";
/** Reference-only presentation, settlement and provider projections for the neutral OMS. */
import type { AdminCommerceOrdersListResponse as NeutralListResponse,AdminCommerceOrderDetailResponse as NeutralDetailResponse,OmsOrderDetail as NeutralDetail,OmsAccountingInvoiceRow as NeutralInvoice,OmsReadModelProjections } from "@openlup/platform/commerce/contracts";
import { ambientSettlementProfile,isAcceptedPlatformCurrency } from "../../lib/currency/platformCurrency.js";
import { timelineLabelForStep } from "../../lib/customerFulfillmentCanon.js";
import { deriveOmnipackProviderOps } from "./omnipackProviderOps.js";
import { adminCommerceOrderDetailResponseSchema,adminCommerceOrdersListResponseSchema,omsAccountingSummarySchema } from "./omsContractReadSchemas.js";
import { omsFirstSubscriptionPricePresentation } from "./omsFirstSubscriptionPricePresentation.js";
import type { OmsAccountingInvoiceRow } from "./omsReadModelRows.js";
export const referenceOmsCurrency = {
  get defaultCurrency() { return ambientSettlementProfile.defaultCurrency; },
  accepts: isAcceptedPlatformCurrency,
};
export function toNeutralInvoice(invoice: OmsAccountingInvoiceRow | null): NeutralInvoice | null {
  return invoice ? { ...invoice, fiscal_status: invoice.ksef_status } : null;
}
export function toReferenceAccounting(accounting: NeutralDetail["accounting"]) {
  const { fiscalStatus, ...rest } = accounting;
  return omsAccountingSummarySchema.parse({ ...rest, ksefStatus: fiscalStatus ?? null });
}
export const referenceOmsProjections: OmsReadModelProjections = {
  currency: referenceOmsCurrency,
  providerOps: input => deriveOmnipackProviderOps({ fulfillmentOrders: input.fulfillmentOrders, dispatchRefs: input.dispatchRefs ?? [], statusEvidence: input.statusEvidence ?? [] }),
  paymentMethodLabel: referencePaymentMethodLabel,
  usesExternalStock: referenceUsesExternalStock,
  timelineLabel: step => step ? timelineLabelForStep(step) : "Status dostawy zaktualizowany",
  dispatchLabel: referenceDispatchLabel,
  dispatchStepLabel: referenceDispatchStepLabel(),
  debugSummary: referenceDebugSummary,
  automaticExceptionHoldSource: "commerce.fulfillment.omnipack_provider_exception",
  automaticExceptionReleaseSource: "commerce.fulfillment.omnipack_provider_exception_healed",
  additionalAccountingStatuses: ["ksef_pending"],
  dispatchedNotPickedStatus: "omnipack_dispatched_not_picked",
  detailFields: input => ({ firstSubscriptionPricePresentation: omsFirstSubscriptionPricePresentation(input.order, input.orderItems, input.orderMoney) }),
  // Preserve required nullable DTO fields after validation under the host compiler profile.
  parseList: value => {
    const response = value as { summaryCounts: Record<string, unknown> };
    const { providerDispatchedNotPicked, ...counts } = response.summaryCounts;
    return adminCommerceOrdersListResponseSchema.parse({ ...response, summaryCounts: { ...counts, omnipackDispatchedNotPicked: counts.omnipackDispatchedNotPicked ?? providerDispatchedNotPicked ?? 0 } }) as NeutralListResponse;
  },
  parseDetail: value => {
    const response = value as { order: NeutralDetail };
    return adminCommerceOrderDetailResponseSchema.parse({ ...response, order: { ...response.order, accounting: toReferenceAccounting(response.order.accounting) } }) as NeutralDetailResponse;
  },
};
