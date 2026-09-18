import { OMNIPACK_DELIVERY_OPTIONS } from "../../../src/domains/shipping/contracts.js";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";

const DHL_ONLY_OPTIONS = [
  {
    id: "dhl-courier-standard",
    kind: "courier",
    deliveryKind: "courier",
    providerKind: "dhl",
    carrierKind: "dhl",
    carrierCode: "DHL",
    service: "dhl_courier_standard",
    serviceCode: "dhl_courier_standard",
    label: "Kurier DHL",
    description: "Dostawa DHL pod adres podany w formularzu.",
    pickupPointRequired: false,
    addressRequired: true,
  },
] as const;

const PICKUP_POINTS = [
  {
    id: "WAW01A",
    provider: "inpost",
    name: "Paczkomat WAW01A",
    address: {
      line1: "Prosta 20",
      postalCode: "00-850",
      city: "Warszawa",
      country: "PL",
    },
  },
  {
    id: "KRK02B",
    provider: "inpost",
    name: "Paczkomat KRK02B",
    address: {
      line1: "Karmelicka 10",
      postalCode: "31-128",
      city: "Krakow",
      country: "PL",
    },
  },
] as const;

// `enabledCarriers` is an optional NARROWING of the declared set: omitted =>
// every declared option (the production default). A set restricts to those
// kinds and can never add one the declaration lacks.
export function createStaticDeliverySelectionPort(
  options: { dhlOnly?: boolean; enabledCarriers?: ReadonlySet<string> } = {},
): DeliverySelectionPort {
  return {
    async listOptions() {
      if (options.dhlOnly) return [...DHL_ONLY_OPTIONS];
      const enabled = options.enabledCarriers;
      return OMNIPACK_DELIVERY_OPTIONS.filter((option) => !enabled || enabled.has(option.carrierKind)).map(
        (option) => ({ ...option }),
      );
    },
    async validatePickupPoint(input) {
      const point = PICKUP_POINTS.find((candidate) => candidate.id === input.pointId.trim());
      return point ? { ...point, address: { ...point.address } } : null;
    },
  };
}
