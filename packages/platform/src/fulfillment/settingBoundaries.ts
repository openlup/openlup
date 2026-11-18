/** @experimental Informational catalogue entries owned by fulfillment. */
export const fulfillmentSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["additionalDeliveryMethods", "cap", "Offer additional delivery methods.", "The delivery contract has a fixed set of native method kinds."],
  ["independentShipments", "cap", "Dispatch independent shipments from one order.", "Native shipment sequencing needs additional fulfillment modeling for this case."],
];
