/** Sparse projections require the full canonical graph and a trusted native binding. */
export const FULFILLMENT_NATIVE_CAPABILITIES = {
  shipment: 'supported', commandFence: 'supported', deliveryAlignment: 'supported',
  stockEvidence: 'supported', observationPersistence: 'supported',
  localInventoryBalances: 'host_required', dispatchContactPreparation: 'host_required',
  productPacks: 'unsupported', providerAccess: 'unsupported', automaticReplacementConfirmation: 'unsupported',
} as const;
