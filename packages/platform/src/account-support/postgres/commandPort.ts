import type {
  ManagedOperatorAuthorityPort, OperatorEmailInput, OperatorEmailCorrectionResult,
} from "../contracts/operator.js";

/** The existing journey adapter exposes the original command subset and result. */
export type CustomerSupportOperatorCommandPort = Pick<ManagedOperatorAuthorityPort,
  "applySubscriptionAction" | "correctSubjectPhone" | "issueRecovery" | "absorbLead"> & {
  correctSubjectEmail(input: OperatorEmailInput): Promise<OperatorEmailCorrectionResult>;
};
