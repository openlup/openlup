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
/** @consumer Reference compensation facade; server/adapters/supabase/commerce/checkoutCompensation.ts and server/adapters/managed/commerce/inventoryReservationPort.ts implement this port. */
export type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
