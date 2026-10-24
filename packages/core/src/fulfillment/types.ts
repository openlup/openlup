export type CanonicalLocalFulfillmentStatus = "provider_received" | "picking" | "packed" | "in_transit" | "delivered" | "exception" | "cancelled";
export type CustomerFulfillmentStep = "paid" | "accepted" | "packing" | "transit" | "delivered" | "exception" | "cancelled";

export interface FulfillmentProgressInput {
  status: string; paymentStatus?: string | null; fulfillmentStatus?: string | null;
  customerFulfillmentStep?: CustomerFulfillmentStep | null;
  trackingTimeline: { eventType: string }[];
}
export interface FulfillmentProgressPresentation {
  completedSteps: CustomerFulfillmentStep[];
  currentStep: CustomerFulfillmentStep | null;
}
