export { renewalIdentity } from "./renewalIdentity.js";
export const NATIVE_SUBSCRIPTION_CAPABILITIES = Object.freeze({
  graph: "native",
  multiCyclePrepaid: Object.freeze({ supported: false, refusalCode: "multi_cycle_prepaid_unsupported" }),
  genericBundleCommands: Object.freeze({ supported: true }),
  commandBoundReceipts: Object.freeze({ supported: true }),
  preparedAttemptStore: Object.freeze({ supported: false, refusalCode: "native_prepared_attempt_store_unsupported" }),
  retryRecovery: "selected", stockRecovery: "unavailable",
  deliveryAdmission: "required", executorCount: 1, defaultEnabled: false,
} as const satisfies import("./contracts/commands.js").SubscriptionCapabilities);
export { executeRenewalCycle, prepareRenewalAttempt, checkRenewalDeliveryAdmission } from "./renewalCycleMechanism.js";
export type { RenewalCyclePolicy } from "./renewalCycleMechanism.js";
export { recordRenewalPreflightBlock, replayRenewalAttempt, declinedRenewalOutcome, requiresActionRenewalOutcome } from "./renewalCycleRefusalMechanism.js";
export type { RenewalPreflightPolicy, RenewalReplayPolicy, RenewalOutcomePolicy } from "./renewalCycleRefusalMechanism.js";
export { propagateRenewalFailure } from "./renewalCycleFailureMechanism.js";
export type { RenewalFailurePolicy } from "./renewalCycleFailureMechanism.js";
export { runAutomaticSubscriptionRenewals, runOneAutomaticSubscriptionRenewal, correlatedLogicalCycle } from "./automaticRenewal.js";
export type { AutomaticRenewalRunStatus, AutomaticRenewalRunResult, AutomaticRenewalRunDeps, AutomaticRenewalPolicy } from "./automaticRenewal.js";
export { createPostgresRenewalStore } from "./postgresRenewalStore.js";
export type { NativeRenewalCodec, SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
export { createPostgresRetryStore } from "./postgresRetryStore.js";
export type { NativeRetryFailure, NativeRetryRequest, NativeRetryPositive, NativeRetryPreparation, NativeRetryRow } from "./postgresRetryStore.js";
export { createPostgresRetryLifecycleBinding } from "./postgresRetryStore.js";
export type { NativeRetryLifecycleBinding } from "./postgresRetryStore.js";

export { createPostgresSubscriptionCommandStore, createPostgresSubscriptionCommands } from "./postgresCommandStore.js";
export type { NativeSubscriptionCommand, NativeSubscriptionCommandBinding } from "./postgresCommandStore.js";
