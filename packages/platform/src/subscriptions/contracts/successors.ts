import type { SubscriptionEditConsent } from "./editConsent.js";
/** @experimental */
export type SuccessorCaseKind = "legacy" | "successor";
/** Terminal decisions never apply themselves during renewal.
 * @experimental
 */
export type SuccessorProposalState = "offered" | "accepted" | "declined" | "expired";
/** @experimental */
export interface SuccessorResolutionRequest {
  caseId: string;
  proposalId: string;
  acceptedQuoteHash: string;
  commandKey: string;
  clientId: string;
  now: string;
}
/** @experimental */
export interface SuccessorProposal {
  id: string;
  subscriptionId: string;
  clientId: string;
  predecessorSkuId: string;
  successorSkuId: string;
  publicationId: string;
  state: SuccessorProposalState;
  quoteHash: string;
  expiresAt: string;
  editConsent: SubscriptionEditConsent;
}
