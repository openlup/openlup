import { dhlOnlyDeliveryEnabled } from "./deliverySelectionFlags";
import type { ConfiguratorFormData } from "./configuratorFormStore";

export function normalizeDeliveryForDhlOnly(
  data: ConfiguratorFormData,
): ConfiguratorFormData {
  if (!dhlOnlyDeliveryEnabled()) return { ...data };
  return {
    ...data,
    deliveryMethod: "courier",
    selectedPickupPoint: null,
    selectedDeliveryOption: null,
  };
}
