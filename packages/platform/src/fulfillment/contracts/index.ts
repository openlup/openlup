export type { DispatchEvidence, FulfillmentDispatchPrepareResult, FulfillmentSelection, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentDispatchPort, FulfillmentRefusal } from "./dispatch.js";
export type { LabelDocument, FulfillmentLabelPort } from "./label.js";
/** G17 local reads/ingress persistence are inline runtime worker inputs; this provider envelope is unchanged. */
export type { FulfillmentObservation, FulfillmentObservationPort, FulfillmentTrackingReference } from "./observation.js";
export type { FulfillmentReadbackResult, FulfillmentReadbackPort } from "./readback.js";
export type { SyncCursor, StockSnapshot, StockMovement, LocalStock, FulfillmentStockSyncProvider, FulfillmentStockSyncPort, FulfillmentProductSyncProvider, FulfillmentProductSyncPort } from "./sync.js";
export type { FulfillmentCapabilityDescriptor } from "./capabilities.js";
export type { DispatchRecord, FulfillmentStorePort, FulfillmentPaidHandoffPort } from "./store.js";
export type { DeliveryAlignmentPort } from "./alignment.js";
export type CanonicalLocalFulfillmentStatus = "provider_received" | "picking" | "packed" | "in_transit" | "delivered" | "exception" | "cancelled";
export type CustomerFulfillmentStep = "paid" | "accepted" | "packing" | "transit" | "delivered" | "exception" | "cancelled";
export type { FulfillmentAdapterConformanceSubject, FulfillmentAdapterConformanceEvidence } from "./conformance.js";
export type { FulfillmentNativeUnsupported } from './nativeUnsupported.js';
export type { FulfillmentReplacementPort, FulfillmentReplacementRequest, FulfillmentReplacementResult } from './replacement.js';
export type { FulfillmentOperatorMutationPort, FulfillmentOperatorMutationResult } from './operator.js';
export type { CustomerDeliveryAlignment, FulfillmentCustomerAlignmentRowsReader } from './customerAlignment.js';
export type { FulfillmentCommerceReadPort, FulfillmentCommerceReadPolicy, FulfillmentOrderStatus, FulfillmentPaymentStatus, FulfillmentCommerceOrder, FulfillmentOrdersListRequest, FulfillmentOrdersListResponse, FulfillmentOrderDetailRequest, FulfillmentOrderDetailResponse, FulfillmentShipmentsOverviewPort, FulfillmentShipmentsOverviewRequest, FulfillmentShipmentsOverviewResponse } from './read.js';
export type { FulfillmentProgressInput, FulfillmentProgressPresentation } from './read.js';
export type { FulfillmentServicesOptions, FulfillmentServices } from './bindings.js';
