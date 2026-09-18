// Provider-neutral carrier → tracking-URL registry — public shipping surface so
// fulfillment (reconciliation enrichment) and commerce (email URL fallback)
// share one carrier vocabulary and URL builder.
export * from "./carrierTrackingUrls.js";
export * from "./deliverySelectionContracts.js";
export * from "./deliverySelectionSummary.js";
// Shared delivery-selection resolver — public shipping surface so the commerce routing
// port and the fulfillment dispatch port resolve the selection through one code path.
export * from "./readDeliverySelectionEvidence.js";
