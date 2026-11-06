export { renewalIdentity } from "./renewalIdentity.js";
export { NATIVE_SUBSCRIPTION_CAPABILITIES } from "./services.js";
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
export { createNativeRenewalCodec } from "./nativeRenewalCodec.js";
export { createPostgresPurchaseRenewalWriter, activateNativePurchaseWithRenewal } from "./nativePurchaseRenewal.js";
export type { NativeRenewalPurchaseFacts, SandboxMethodHealth } from "./nativePurchaseRenewal.js";
export { createPostgresSandboxRenewalRail, createSandboxRenewalPolicy } from "./sandboxRenewalRail.js";
export type { SandboxRenewalScenario } from "./sandboxRenewalRail.js";
export { createNativeSubscriptionBinding } from "./nativeSubscriptionBinding.js";
export { createNativeRetryDriver } from "./nativeRetryDriver.js";
export type { NativeRetryDriverOptions } from "./nativeRetryDriver.js";
export { nativeSubscriptionSchema } from "./nativeSubscriptionSchema.js";
export { withNativeDeliveryAlignmentRenewalAdmission } from "./postgresDeliveryAlignmentStore.js";
export { createPostgresRenewalSettlementPort } from "./postgresRenewalSettlement.js";

export { createPostgresRetryStore } from "./postgresRetryStore.js";
export type { NativeRetryFailure, NativeRetryRequest, NativeRetryPositive, NativeRetryPreparation, NativeRetryRow } from "./postgresRetryStore.js";
export { createPostgresRetryLifecycleBinding } from "./postgresRetryStore.js";
export type { NativeRetryLifecycleBinding } from "./postgresRetryStore.js";

export { createPostgresSubscriptionCommandStore, createPostgresSubscriptionCommands } from "./postgresCommandStore.js";
export type { NativeSubscriptionCommand, NativeSubscriptionCommandBinding } from "./postgresCommandStore.js";

export { createPostgresStockWaitStore } from "./postgresStockWaitStore.js";
export type { NativeStockWaitBinding, NativeStockWaitAdmission } from "./postgresStockWaitStore.js";

/** Managed SQL is exposed for service-role hosts; no StockWaitStorePort
 * TypeScript adapter is composed for this graph. A NewPurchaseStockReadPort
 * adapter is available in ../inventory for managed service-role hosts.
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
export { createPostgresLifecycleMessages, type NativeLifecycleMessagesOptions, type NativeLifecycleNotice } from "./postgresLifecycleMessages.js";
export { createSubscriptionCommandExamples } from "./commandExamples.js";
export { createSubscriptionServices } from "./services.js";
export { createClassicPackageRepricer, hashPackageEditQuote } from "./classicPackageQuote.js";
export { createPostgresPackageEditReadPort } from "./packageEditRead.js";
export { createPostgresPackageEditor } from "./packageEditor.js";
export { createPostgresSizedEditor, createOfferDispatchedSubscriptionEditor, mapSizedEditError } from "./sizedEditor.js";
export { createSizedParcelProjection } from "./sizedParcelProjection.js";
export type { SizedParcelProjectionPorts } from "./sizedParcelProjection.js";
export { createSizedEditContextScope, readSizedEditContext, sizedEditPhase, isSizedOptIn, normalizeSizedEdit } from "./sizedEditContext.js";
export { createSizedCompositionRules } from "./sizedComposition.js";
export { quoteSizedEdit, selectSizedAgreements, sizedCandidateCompatibility } from "./sizedEditQuote.js";
export { splitBySubscriptionAgreement, agreedSubscriptionTotal, mergeSubscriptionAgreedQuote } from "./agreedPlanQuote.js";
export type { SizedEditorOptions, SizedHostPorts, SizedSubjectFacts, SizedCatalogFact } from "./sizedEditPorts.js";
export { SIZED_PARCEL_LEVER_KIND } from "./contracts/sizedEdit.js";
export type { SizedEditAction, SizedEditRequest, SizedEditPhase, SizedAgreedLine, SizedEditContext, SizedEditPolicy,
  SizedPricedLine, SizedEditQuote, SizedEditPreview, SizedEditApplyResult, SizedQuoteLine, SizedRecurringQuote, SizedQuoteRequest } from "./contracts/sizedEdit.js";
export { mapPackageEditError } from "./packageEditErrors.js";
export type { PackageEditErrorMapping } from "./packageEditErrors.js";
export type { PackageEditMoney, PackageEditLine, PackageEditQuoteLine, PackageEditPricedLine, PackageEditRequest, PackageEditQuote,
  PackageEditSubscription, PackageEditCurrentLine, PackageEditConstraintMapper, PackageEditReadPort, PackageEditQuotePorts,
  PackageEditLimits, PackageEditorOptions, PackageEditActor, PackageEditBlockedReason, PackageEditPreview, PackageEditApplyResult } from "./packageEditContracts.js";

export type { ExactSubscriptionEditAction, ExactSubscriptionEditRequest, SubscriptionEditRequest, ExactSubscriptionEditPreview,
  ExactSubscriptionEditApplyResult, ExactSubscriptionEditPricedLine, ExactSubscriptionEditQuote, SubscriptionPortionModes } from "./contracts/exactEdit.js";
export { createExactSubscriptionRepricer } from "./exactEditQuote.js";
export { createSubscriptionSizingRules, apportionSubscriptionUnits } from "./subscriptionSizing.js";
export type { SubscriptionSizingUnit, SubscriptionSizingPolicy } from "./subscriptionSizing.js";
