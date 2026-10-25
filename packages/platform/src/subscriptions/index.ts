export { renewalIdentity } from "./renewalIdentity.js";
export const NATIVE_SUBSCRIPTION_CAPABILITIES = Object.freeze({
  graph: "native",
  multiCyclePrepaid: Object.freeze({ supported: false, refusalCode: "multi_cycle_prepaid_unsupported" }),
  genericBundleCommands: Object.freeze({ supported: true }),
  commandBoundReceipts: Object.freeze({ supported: true }),
  preparedAttemptStore: Object.freeze({ supported: false, refusalCode: "native_prepared_attempt_store_unsupported" }),
  retryRecovery: "selected",
  // Native N3 adapters exist; selection requires passing real-PG evidence.
  stockRecovery: "unavailable",
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

export { createPostgresStockWaitStore } from "./postgresStockWaitStore.js";
export type { NativeStockWaitBinding, NativeStockWaitAdmission } from "./postgresStockWaitStore.js";

/** Managed SQL is exposed for service-role hosts; no StockWaitStorePort or
 * NewPurchaseStockReadPort TypeScript adapter is composed for this graph.
 * SQL behavior is proved by the managed pgTAP/real-PostgreSQL witnesses.
 */
export const MANAGED_SUBSCRIPTION_STOCK_CAPABILITIES = Object.freeze({
  graph: "managed",
  stockRecovery: "unavailable",
  stockWaitSurface: "sql",
  stockAvailabilitySurface: "sql",
  defaultEnabled: false,
} as const);

export { runRenewalBatchRows } from "./automaticRenewalExecution.js";
export type { SubscriptionLifecycleFact } from "./contracts/messages.js";

export { subscriptionLifecycleTemplate, createSubscriptionLifecycleMessages } from "./lifecycleMessages.js";
export { createSubscriptionCommandExamples } from "./commandExamples.js";
export { createSubscriptionServices } from "./services.js";
