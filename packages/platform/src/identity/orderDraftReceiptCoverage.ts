import type { ContributorDisposition } from "./privacyPorts.js";
import type { PersonalDataObligation } from "./contracts/privacy.js";

export const orderDraftReceiptContributorId = "order-draft-receipts";
export const orderDraftReceiptContributorVersion = "commerce.order-draft-receipts.v1";
export const orderDraftReceiptReconciliationId = Symbol("orderDraftReceiptReconciliationId");
const receiptDispositionRequirements = [
  ["commerce.order-draft-receipt-owner-references", "erase", "RECEIPT_OWNER_REFERENCES_CLEARED"],
  ["commerce.order-draft-receipt-retained-facts", "retain", "ORDER_REFERENCE_AND_DERIVED_REPLAY_KEY_RETAINED"],
] as const;

export function orderDraftReceiptObligations(): PersonalDataObligation[] {
  return receiptDispositionRequirements.map(([resource, disposition, reasonCode]) => ({
    owner: orderDraftReceiptContributorId, resource, disposition, reasonCode, remote: false,
  }));
}

export function hasOrderDraftReceiptDisposition(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((disposition: Partial<ContributorDisposition> | null) => {
    const obligations = disposition?.obligations;
    return disposition?.contributorId === orderDraftReceiptContributorId
      && disposition.version === orderDraftReceiptContributorVersion && Array.isArray(obligations)
      && receiptDispositionRequirements.every(([resource, action, reasonCode]) => obligations.some(obligation =>
        obligation?.owner === orderDraftReceiptContributorId && obligation.resource === resource
        && obligation.disposition === action && obligation.reasonCode === reasonCode && obligation.remote === false));
  });
}
