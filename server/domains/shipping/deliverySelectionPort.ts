import type {
  DeliveryCarrierKind,
  DeliveryOption,
  PickupPoint,
} from "../../../src/domains/shipping/deliverySelectionContracts.js";

export interface DeliverySelectionPort {
  listOptions(): Promise<DeliveryOption[]>;
  validatePickupPoint(input: { pointId: string; carrierKind: DeliveryCarrierKind }): Promise<PickupPoint | null>;
}
