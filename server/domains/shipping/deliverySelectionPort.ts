import type { DeliverySelectionPort as PlatformDeliverySelectionPort } from "@openlup/platform/shipping";
import type {
  DeliveryCarrierKind,
  DeliveryOption,
  PickupPoint,
} from "../../../src/domains/shipping/deliverySelectionContracts.js";

export interface DeliverySelectionPort extends PlatformDeliverySelectionPort {
  listOptions(): Promise<DeliveryOption[]>;
  validatePickupPoint(input: { pointId: string; carrierKind: DeliveryCarrierKind }): Promise<PickupPoint | null>;
}
