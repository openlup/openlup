import type { DeliverySelectionPort } from './deliverySelectionPort.js';
import type { PickupPointSearchPort } from './pickupPointSearchPort.js';
import type { DeliveryOption, PickupPoint } from './contracts/index.js';

/** Adapters decode their own dictionary and supply normalized options and point I/O. */
export function createDeliverySelectionBoundary(input: {
  dictionary: { valid: boolean; options: readonly DeliveryOption[] };
  acceptedCatalog: readonly DeliveryOption[];
  allowedCarriers: ReadonlySet<string>;
  fallbackValidation: DeliverySelectionPort['validatePickupPoint'];
  pointSources?: Readonly<Record<string, { getById(id: string): Promise<PickupPoint | null>; search: PickupPointSearchPort['searchPickupPoints'] }>>;
}): { source: 'dictionary' | 'static_accepted_catalog'; enabledCarriers: string[]; port: DeliverySelectionPort; searchPort: PickupPointSearchPort } {
  const dictionary = input.dictionary.valid;
  const source = dictionary ? 'dictionary' : 'static_accepted_catalog';
  const options = (dictionary ? input.dictionary.options : input.acceptedCatalog)
    .filter(option => (!dictionary && input.allowedCarriers.size === 0) || input.allowedCarriers.has(option.carrierKind));
  const enabledCarriers = dictionary ? [...input.allowedCarriers] : [...new Set(options.map(option => option.carrierKind))];
  const enabled = new Set(enabledCarriers);
  return { source, enabledCarriers,
    port: {
      async listOptions() { return options.map(option => ({ ...option })); },
      async validatePickupPoint(request) {
        if (!enabled.has(request.carrierKind)) return null;
        const points = input.pointSources?.[request.carrierKind];
        if (!points) return input.fallbackValidation(request);
        const id = request.pointId.trim();
        return id ? points.getById(id) : null;
      },
    },
    searchPort: { async searchPickupPoints(request) {
      if (!enabled.has(request.carrierKind)) return [];
      return input.pointSources?.[request.carrierKind]?.search(request) ?? [];
    } },
  };
}
