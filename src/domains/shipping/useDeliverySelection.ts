import { useCallback, useEffect, useState } from "react";

import type { DeliveryOption, PickupPoint } from "@/domains/shipping/deliverySelectionContracts";
import { getDeliveryOptions } from "@/domains/shipping/deliverySelectionClient";

/** Only selection state crosses this reference seam; checkout owns its form. */
interface DeliverySelectionData {
  pendingDeliveryOptionId: string | null;
  selectedDeliveryOption: DeliveryOption | null;
  selectedPickupPoint: PickupPoint | null;
  deliveryMethod: "courier" | "parcel-locker";
}

interface UseDeliverySelectionOptions {
  enabled: boolean;
  data: DeliverySelectionData;
  update: (patch: Partial<DeliverySelectionData>) => void;
}

export interface DeliverySelectionState {
  deliveryOptions: DeliveryOption[];
  deliveryOptionsLoading: boolean;
  selectDeliveryOption: (option: DeliveryOption) => void;
}

/** `deliveryMethod` is always derived from the option's kind, never set independently. */
function isLockerOption(option: DeliveryOption): boolean {
  return (option.deliveryKind ?? option.kind) === "parcel-locker";
}

/**
 * Loads the delivery dictionary and re-resolves a persisted selection id.
 */
export function useDeliverySelection({
  enabled,
  data,
  update,
}: UseDeliverySelectionOptions): DeliverySelectionState {
  const [deliveryOptions, setDeliveryOptions] = useState<DeliveryOption[]>([]);
  // Effects run after the first committed render. An enabled dictionary must
  // therefore begin loading, so Step 5 never briefly exposes the legacy radios.
  const [deliveryOptionsLoading, setDeliveryOptionsLoading] = useState(enabled);
  const pendingDeliveryOptionId = data.pendingDeliveryOptionId;
  const selectedPickupPoint = data.selectedPickupPoint;

  // Dictionary failure clears stale evidence and permits manual method selection.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setDeliveryOptionsLoading(true);
    getDeliveryOptions()
      .then((response) => { if (active) setDeliveryOptions(response.options); })
      .catch(() => {
        if (!active) return;
        setDeliveryOptions([]);
        update({ selectedDeliveryOption: null, selectedPickupPoint: null });
      })
      .finally(() => { if (active) setDeliveryOptionsLoading(false); });
    return () => { active = false; };
  }, [enabled, update]);

  // Resume: the draft carries only the chosen option's id. Once the fresh list
  // lands, re-resolve it and drop the marker either way — a withdrawn or re-keyed
  // carrier must fall back to "nothing selected" rather than silently carrying a
  // stale server price into checkout.
  useEffect(() => {
    if (!pendingDeliveryOptionId || deliveryOptionsLoading || !deliveryOptions.length) return;
    const restored = deliveryOptions.find((option) => option.id === pendingDeliveryOptionId);
    if (!restored) {
      update({ pendingDeliveryOptionId: null });
      return;
    }
    update({
      pendingDeliveryOptionId: null,
      selectedDeliveryOption: restored,
      deliveryMethod: isLockerOption(restored) ? "parcel-locker" : "courier",
      selectedPickupPoint: restored.pickupPointRequired ? selectedPickupPoint : null,
    });
  }, [
    pendingDeliveryOptionId,
    deliveryOptions,
    deliveryOptionsLoading,
    selectedPickupPoint,
    update,
  ]);

  const selectDeliveryOption = useCallback(
    (option: DeliveryOption) => {
      update({
        selectedDeliveryOption: option,
        deliveryMethod: isLockerOption(option) ? "parcel-locker" : "courier",
        selectedPickupPoint: option.pickupPointRequired ? selectedPickupPoint : null,
      });
    },
    [update, selectedPickupPoint],
  );

  return { deliveryOptions, deliveryOptionsLoading, selectDeliveryOption };
}
