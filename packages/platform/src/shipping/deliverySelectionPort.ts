import type {
  DeliveryCarrierKind,
  DeliveryOption,
  PickupPoint,
} from "./contracts/index.js";

export interface DeliverySelectionPort {
  listOptions(): Promise<DeliveryOption[]>;
  validatePickupPoint(input: { pointId: string; carrierKind: DeliveryCarrierKind }): Promise<PickupPoint | null>;
}
