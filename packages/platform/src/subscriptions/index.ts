export { renewalIdentity } from "./renewalIdentity.js";
export const NATIVE_SUBSCRIPTION_CAPABILITIES = Object.freeze({
  graph: "native",
  multiCyclePrepaid: Object.freeze({ supported: false, refusalCode: "multi_cycle_prepaid_unsupported" }),
  genericBundleCommands: Object.freeze({ supported: false, refusalCode: "native_generic_bundle_commands_unsupported" }),
  commandBoundReceipts: Object.freeze({ supported: false, refusalCode: "native_command_bound_receipts_unsupported" }),
  preparedAttemptStore: Object.freeze({ supported: false, refusalCode: "native_prepared_attempt_store_unsupported" }),
  retryRecovery: "unavailable", stockRecovery: "unavailable",
  deliveryAdmission: "required", executorCount: 1, defaultEnabled: false,
} as const satisfies import("./contracts/commands.js").SubscriptionCapabilities);
export { executeRenewalCycle, prepareRenewalAttempt, checkRenewalDeliveryAdmission } from "./renewalCycleMechanism.js";
export type { RenewalCyclePolicy } from "./renewalCycleMechanism.js";
export { recordRenewalPreflightBlock, replayRenewalAttempt, declinedRenewalOutcome, requiresActionRenewalOutcome } from "./renewalCycleRefusalMechanism.js";
export type { RenewalPreflightPolicy, RenewalReplayPolicy, RenewalOutcomePolicy } from "./renewalCycleRefusalMechanism.js";
export { propagateRenewalFailure } from "./renewalCycleFailureMechanism.js";
export type { RenewalFailurePolicy } from "./renewalCycleFailureMechanism.js";
