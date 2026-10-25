/**
 * Node-only commerce entry for server handlers, use cases, stores and adapters.
 * Node builtins, database clients, HTTP/storage operations and engine composition
 * belong here; commerce remains for browser-safe schemas, pure helpers and ports,
 * while commerce/contracts stays type-only.
 */
export { buildOmsOrderDetailResponse } from "../model/omsReadModel.js";
export { createAdminCommerceOrderCancelHandler } from "./commerceOmsCancelOrderHandler.js";
export { createAdminCommerceOrdersListHandler, createAdminCommerceOrderDetailHandler, createAdminCommerceOrderHoldHandler, createAdminCommerceOrderReleaseHoldHandler, createAdminCommerceOrderNoteHandler, createAdminCommerceOrderUpdateShippingAddressHandler, authorize, parseOmsRequest, sendOmsMutationResponse } from "./commerceOmsHandlers.js";
export type { AdminAuthResult, BaseDeps } from "./commerceOmsHandlers.js";
export { createAdminCommerceOrderMarkRefundedHandler } from "./commerceOmsMarkRefundedHandler.js";
export { createCommerceOmsControlPlaneListHandler, createCommerceOmsControlPlaneDetailHandler } from "./commerceOmsControlPlaneHandlers.js";
export { createManagedCommerceOmsPort, mapReplacementRefusal } from "../adapters/managed/commerceOmsPort.js";
export type { CommerceOmsRpcClient } from "../adapters/managed/commerceOmsPort.js";
export { addCommerceOmsNote, updateCommerceOmsShippingAddress, callOmsRpc, mapRpcError } from "../adapters/managed/commerceOmsMutations.js";
export { createManagedCommerceOmsControlPlanePort } from "../adapters/managed/commerceOmsControlPlane.js";
export { readAccountingOutbox } from "../adapters/managed/oms/accounting.js";
export { readOmsInboundEvents } from "../adapters/managed/oms/inboundEvents.js";
export { readOrderPaidOutboxEvents } from "../adapters/managed/oms/outboxEvents.js";
export { readActivePaymentAttempts } from "../adapters/managed/oms/paymentAttempts.js";
export { readQueueSelection } from "../adapters/managed/oms/queueSelection.js";
export type { QueueSelection } from "../adapters/managed/oms/queueSelection.js";
export { distinctIds } from "../adapters/managed/oms/types.js";
export type { CommerceOmsStore, ManagedQueryBuilder, ManagedQueryResult, RpcError } from "../adapters/managed/oms/types.js";
export { readShipmentRefsByOrderIds, readShipmentRefsByOrderId, isOptionalProviderEvidenceColumnError, readFulfillmentParcelsByOrderId, readFulfillmentOrdersByOrderIds } from "../adapters/managed/oms/fulfillmentReads.js";
export { listCommerceOmsOrders, getCommerceOmsOrderDetail, getCommerceOmsOrderDetails } from "../adapters/managed/oms/readQueries.js";
export { unprojectedOmsReadGate } from "./handlerSupport.js";
export type { OmsHandlerRequest, OmsHandlerResponder, OmsAdminAuthResult, OmsReadGate, OmsHandlerDeps } from "./handlerSupport.js";
export { emptyOmsManagedReadProjections } from "../adapters/managed/oms/readProjections.js";
export type { OmsManagedReadProjections } from "../adapters/managed/oms/readProjections.js";
export { createCustomerReturnRequestHandler, createAdminReturnApproveHandler, createAdminReturnRejectHandler } from "./commerceReturnsHandlers.js";
export { createOrderReviewHandlers } from "./orderReviewHandlers.js";
export { createOrderReviewAdminHandlers } from "./orderReviewAdminHandlers.js";
export { createOrderReviewRawUploadHandler, inspectImageHeader } from "./orderReviewRawUploadHandler.js";
export type { OrderReviewMediaMime, OrderReviewRawUploadSession, OrderReviewRawUploadBinding, OrderReviewRawUploadResult, OrderReviewRawUploadBindingState } from "./orderReviewRawUploadHandler.js";
export { createPostgresOrderReviewLifecyclePort, createPostgresOrderReviewAdminReadPort } from "./orderReviewLifecycle.js";
export { createPostgresOrderReviewMediaPort } from "./orderReviewMedia.js";
export type { OrderReviewMediaTransactionLane } from "./orderReviewMedia.js";
export { createSupabaseCommerceReturnsPort } from "./supabaseCommerceReturnsPort.js";
export type { CommerceReturnsRpcClient } from "./supabaseCommerceReturnsPort.js";
export { createSupabaseOrderFeedbackSubmitPort } from "./orderFeedbackSubmit.js";
export type { OrderFeedbackSubmitRpcClient, OrderFeedbackSubmitPort } from "./orderFeedbackSubmit.js";
export { createSupabaseOrderFeedbackTokenCheckPort } from "./orderFeedbackTokenCheck.js";
export type { OrderFeedbackTokenCheckRpcClient } from "./orderFeedbackTokenCheck.js";

/** Node-only commerce effect consumers. Hosts bind runtime and presentation ports. */
export * from "./emailRuntime.js";
export * from "./outboxDispatchRegistry.js";
export * from "./outboxDispatchRegistryComposition.js";
export * from "./outboxCheckoutExpiredEmailHandler.js";
export * from "./outboxCheckoutRecoveryEmailHandler.js";
export * from "./outboxOrderDraftEmailHandler.js";
export * from "./outboxOrderPaidEmailHandler.js";
export * from "./outboxOrderPaidFulfillmentHandler.js";
export * from "./outboxOrderPaidFulfillmentPorts.js";
export * from "./outboxOrderRefundedEmailHandler.js";
export * from "./outboxPaymentFailedEmailHandler.js";
export * from "./outboxReturnEmailHandlers.js";
export * from "./outboxShipmentDeliveredEmailHandler.js";
export * from "./outboxShipmentDispatchedEmailHandler.js";
export * from "./outboxShipmentExceptionEmailHandler.js";

/** @consumer server/domains/commerce/commerceCheckoutCompensation.ts */
export { tryCompensate } from "./commerceCheckoutCompensation.js";
/** @consumer server/domains/commerce/commerceCheckoutCompensation.ts */
export type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
/** @consumer server/domains/commerce/commerceCheckoutOrchestrationError.ts */
export { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
/** @consumer server/domains/commerce/checkoutConflictClassifiers.ts */
export { isStockUnavailableCheckoutConflict, isProviderAttemptInFlightCheckoutConflict, isJourneyConsumedCheckoutConflict, START_RUNTIME_SIMPLE_CONFLICTS } from "./checkoutConflictClassifiers.js";
/** @consumer server/domains/commerce/commerceDiagnostics.ts */
export { safeCommerceDiagnosticValue, checkoutOrchestrationFailureDetails } from "./commerceDiagnostics.js";
/** @consumer server/domains/commerce/checkoutPaymentContinuationCredential.ts */
export { mintPaymentContinuationOnFreshAction, createCheckoutPaymentContinuationCodec } from "./checkoutPaymentContinuationCredential.js";
/** @consumer server/domains/commerce/checkoutPaymentContinuationCredential.ts */
export type { CheckoutPaymentContinuationInput, CheckoutPaymentContinuationClaims, CheckoutPaymentContinuationCodec, CheckoutPaymentContinuationMinter, CheckoutCookieResponse } from "./checkoutPaymentContinuationCredential.js";
/** @consumer server/domains/commerce/checkoutRefusalContinuation.ts */
export { mintCheckoutRefusalContinuation } from "./checkoutRefusalContinuation.js";
/** @consumer server/domains/commerce/commerceCheckoutProviderPayment.ts */
export { createCheckoutClientAction, providerPayerFromRequest } from "./commerceCheckoutProviderPayment.js";
/** @consumer server/domains/commerce/checkoutOfferPolicyPort.ts */
export { CHECKOUT_OFFER_VERSION_UNSUPPORTED, CheckoutOfferRefusedError, resolveCheckoutOffer, withCheckoutOfferContext } from "./checkoutOfferPolicyPort.js";
/** @consumer server/domains/commerce/checkoutOfferPolicyPort.ts */
export type { CheckoutOfferPolicyPort, CheckoutOfferBinding } from "./checkoutOfferPolicyPort.js";
/** @consumer server/domains/commerce/commerceCheckoutCustomerDefaults.ts */
export { readCheckoutCustomerDefaults, readCheckoutCustomerDefaultsOrRespond } from "./commerceCheckoutCustomerDefaults.js";
/** @consumer server/domains/commerce/commerceCheckoutTiming.ts */
export { createCheckoutTimingLogger } from "./commerceCheckoutTiming.js";
/** @consumer server/domains/commerce/commerceCheckoutTiming.ts */
export type { CheckoutTimingStage, CheckoutTimingOutcome, CheckoutStage, CheckoutStageRecorder } from "./commerceCheckoutTiming.js";
/** @consumer server/domains/commerce/checkoutInvoiceBuyerSnapshot.ts */
export { buildCheckoutInvoiceBuyerSnapshot } from "./checkoutInvoiceBuyerSnapshot.js";
/** @consumer server/domains/commerce/commerceCheckoutSavedPaymentMethod.ts */
export { createCheckoutSavedPaymentMethodResolver } from "./commerceCheckoutSavedPaymentMethod.js";
/** @consumer server/domains/commerce/commerceCheckoutSavedPaymentMethod.ts */
export type { ResolveSavedMethodResult } from "./commerceCheckoutSavedPaymentMethod.js";
/** @consumer server/domains/commerce/commerceStarterOfferGuard.ts */
export { createStarterOfferGuard, withStarterPackContext } from "./commerceStarterOfferGuard.js";
/** @consumer server/domains/commerce/commerceStarterOfferGuard.ts */
export type { StarterOfferGuardResult } from "./commerceStarterOfferGuard.js";
/** @consumer src/domains/commerce/starterTermsPort.ts */
export type { StarterTermsPort, StarterTermsDecision, StarterTermsResolution, StarterTermsRefusal } from "./starterTermsPort.js";
/** @consumer server/domains/commerce/commerceCheckoutQuoteGuard.ts */
export { createCheckoutQuoteGuard } from "./commerceCheckoutQuoteGuard.js";
/** @consumer server/domains/commerce/commerceCheckoutQuoteGuard.ts */
export type { CheckoutQuoteGuardResult } from "./commerceCheckoutQuoteGuard.js";
/** @consumer server/domains/commerce/commerceCheckoutResumeGuard.ts */
export { createCheckoutResumeGuard, selectedDeliveryMatches, subscriptionResponse } from "./commerceCheckoutResumeGuard.js";
/** @consumer server/domains/commerce/commerceCheckoutResumeGuard.ts */
export type { CheckoutResumeGuardDeps, QuoteLikeSnapshot } from "./commerceCheckoutResumeGuard.js";
/** @consumer server/domains/commerce/commerceCheckoutContinuationTerms.ts */
export { createSavedAcquisitionContinuation } from "./commerceCheckoutContinuationTerms.js";
/** @consumer server/domains/commerce/commerceProviderAttemptFailure.ts */
export { createCheckoutProviderAttemptFailure } from "./commerceProviderAttemptFailure.js";
/** @consumer server/domains/commerce/commerceCheckoutStartRuntimeFailure.ts */
export { createCheckoutStartRuntimeFailure } from "./commerceCheckoutStartRuntimeFailure.js";
/** @consumer server/domains/commerce/commerceRuntimeStartResponse.ts */
export { createRuntimeStartResponse } from "./commerceRuntimeStartResponse.js";
/** @consumer server/domains/commerce/commerceRuntimeService.ts */
export { createCommerceRuntimeService } from "./commerceRuntimeService.js";
/** @consumer server/domains/commerce/commercePaidOrderOrchestration.ts */
export { createPaidOrderOrchestration } from "./commercePaidOrderOrchestration.js";
/** @consumer server/domains/commerce/commercePaidOrderOrchestration.ts */
export type { OrchestratedCheckoutResult, CheckoutPaymentStartedEvent } from "./commercePaidOrderOrchestration.js";
/** @consumer server/domains/commerce/commerceCheckoutCommandExecution.ts */
export { createCheckoutCommandExecutor, checkoutCommandJourney } from "./commerceCheckoutCommandExecution.js";
/** @consumer server/domains/commerce/configuratorIntentPersistenceHandler.ts */
export { createConfiguratorIntentPersistenceHandler, ConfiguratorIntentPersistenceConflictError } from "./configuratorIntentPersistenceHandler.js";
/** @consumer server/domains/commerce/referenceCheckoutHandler.ts */
export { createReferenceCheckoutHandler } from "./referenceCheckoutHandler.js";
/** @consumer server/domains/commerce/commerceCheckoutHandlerHelpers.ts */
export { createCheckoutHandlerHelpers, runBestEffortAccountLink } from "./commerceCheckoutHandlerHelpers.js";
/** @consumer server/domains/commerce/commerceCheckoutHandlerAdmission.ts */
export { createCheckoutAdmission } from "./commerceCheckoutHandlerAdmission.js";
/** @consumer server/domains/commerce/commerceCheckoutPromotionPriceChange.ts */
export { createPromotionPriceChange } from "./commerceCheckoutPromotionPriceChange.js";
/** @consumer server/domains/commerce/commerceCheckoutFailureHandler.ts */
export { createCheckoutFailureHandler } from "./commerceCheckoutFailureHandler.js";
/** @consumer server/domains/commerce/commerceCheckoutHandler.ts */
export { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
/** @consumer server/domains/commerce/orderDraftRpcPayload.ts */
export { ORDER_DRAFT_RPC_NAME, createOrderDraftRpcPayload } from "./orderDraftRpcPayload.js";
/** @consumer Reference order-draft store binding. */
export { createSupabaseCommerceOrderDraftPort, ORDER_DRAFT_SUPERSEDE_RPC_NAME } from "./commerceOrderDraft.js";
/** @consumer Reference order-draft store binding. */
export type { CommerceOrderDraftRpcClient } from "./commerceOrderDraft.js";
/** @consumer server/adapters/managed/commerce/commerceRuntimePort.ts */
export { createManagedCommerceRuntimeOrderPort, mapRpcError as mapCommerceFinalizeRpcError } from "./commerceRuntimePort.js";
/** @consumer server/adapters/managed/commerce/commerceRuntimePort.ts */
export type { ManagedCommerceRuntimeClient } from "./commerceRuntimePort.js";
/** @consumer server/adapters/managed/commerce/reservationSweepPort.ts */
export { createManagedReservationSweepPort } from "./reservationSweepPort.js";
/** @consumer server/adapters/managed/commerce/reservationSweepPort.ts */
export type { ReservationSweepCounts, ReservationSweepRpcClient, RetryHoldSweepCounts } from "./reservationSweepPort.js";
/** @consumer Reference checkout compensation binding. */
export { createSupabaseCheckoutCompensationAdapter, cancelAbandonedCheckout, cancelUnstartedPromotionCheckout } from "./checkoutCompensation.js";
/** @consumer Reference checkout compensation binding. */
export type { CompensationRpcClient } from "./checkoutCompensation.js";
/** @consumer server/domains/commerce/checkoutRecoveryToken.ts */
export { hashCheckoutRecoveryToken, generateCheckoutRecoveryToken, CHECKOUT_RECOVERY_TOKEN_PREFIX, classifyCheckoutRecoveryTokenState } from "./checkoutRecoveryToken.js";
/** @consumer server/domains/commerce/checkoutRecoveryToken.ts */
export type { CheckoutRecoveryTokenContext, CheckoutRecoveryTokenInspection, CheckoutRecoveryTokenPort } from "./checkoutRecoveryToken.js";
/** @consumer server/domains/commerce/checkoutRecoveryOrderPort.ts */
export type { CheckoutRecoveryOrderSnapshot, CheckoutRecoveryOrderReadPort, CheckoutRecoveryPriorPaymentEvidence } from "./checkoutRecoveryOrderPort.js";
/** @consumer server/domains/commerce/checkoutExpiredRecoveryPolicy.ts */
export { createExpiredCheckoutRecoveryPolicy, EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS, quotesMatchForRecovery } from "./checkoutExpiredRecoveryPolicy.js";
/** @consumer server/domains/commerce/checkoutExpiredRecoveryPolicy.ts */
export type { ExpiredRecoveryEligibility } from "./checkoutExpiredRecoveryPolicy.js";
/** @consumer Reference checkout resume store binding. */
export { createSupabaseCommerceCheckoutResumePort } from "./commerceCheckoutResume.js";
/** @consumer Reference checkout resume store binding. */
export type { CommerceCheckoutResumeClient } from "./commerceCheckoutResume.js";
/** @consumer Reference configurator intent persistence binding. */
export { createSupabaseConfiguratorIntentPersistencePort } from "./configuratorIntentPersistence.js";
/** @consumer Reference configurator intent persistence binding. */
export type { ConfiguratorIntentSupabaseClient, ConfiguratorIntentPersistenceIdentity } from "./configuratorIntentPersistence.js";
