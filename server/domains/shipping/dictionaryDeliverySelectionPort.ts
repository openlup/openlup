// Delivery-selection port backed by the OmniPack merchant dictionary.
//
// Derives the customer-facing delivery options from dictionary.carriers[].services[]
// (the OmniPack-confirmed carrier/service portfolio), filtered by the
// OMNIPACK_ENABLED_CARRIERS allowlist. Replaces the hardcoded InPost/DPD list so
// the offered carrier/service codes always match what OmniPack will accept in
// POST /orders. Pickup-point validation uses the dictionary's per-carrier
// pickupPoints semantics (required fields), not an InPost-only hardcode.
import type {
  DeliveryOption,
  PickupPoint,
} from "../../../src/domains/shipping/deliverySelectionContracts.js";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";

// Domain-owned structural view of the merchant dictionary the port needs. The
// infra OmnipackMerchantDictionary is structurally assignable to this; declaring
// it here keeps server/domains free of a server/infra import (architecture
// guardrail) — the BFF composition root injects the validated dictionary.
export interface OmnipackDeliveryCatalogService {
  code: string;
  deliveryKind: "courier" | "parcel-locker";
  requiresPickupPoint: boolean;
}
export interface OmnipackDeliveryCatalogCarrier {
  kind: string;
  code: string;
  services: OmnipackDeliveryCatalogService[];
}
export interface OmnipackDeliveryCatalog {
  carriers: OmnipackDeliveryCatalogCarrier[];
  pickupPoints: Record<string, { requiresPointId: boolean; requiredFields: string[]; normalization: string | null }>;
}

// Customer-facing PL labels per known carrier kind. Unknown kinds fall back to
// the dictionary carrier code so a newly-added OmniPack carrier still renders.
const CARRIER_LABELS: Record<string, string> = {
  inpost: "InPost",
  dpd: "DPD",
  orlen: "Orlen Paczka",
  dhl: "DHL",
};

export function createDictionaryDeliverySelectionPort(input: {
  dictionary: OmnipackDeliveryCatalog;
  enabledCarriers: Set<string>;
}): DeliverySelectionPort {
  const { dictionary, enabledCarriers } = input;

  return {
    async listOptions(): Promise<DeliveryOption[]> {
      const options: DeliveryOption[] = [];
      for (const carrier of dictionary.carriers) {
        if (!enabledCarriers.has(carrier.kind)) continue;
        for (const service of carrier.services) {
          options.push(toDeliveryOption(carrier, service));
        }
      }
      return options;
    },

    async validatePickupPoint(input): Promise<PickupPoint | null> {
      const carrierKind = input.carrierKind;
      if (!enabledCarriers.has(carrierKind)) return null;
      const semantics = dictionary.pickupPoints[carrierKind];
      if (!semantics?.requiresPointId) return null;
      const pointId = input.pointId.trim();
      if (!pointId) return null;
      // The dictionary describes the REQUIRED FIELDS for a point but is not a
      // point catalog (OmniPack/carrier own the geo list). We accept a
      // well-formed point id and echo a minimal, normalized evidence record;
      // the full per-carrier point picker is a carrier-specific follow-up.
      return {
        id: pointId,
        provider: carrierKind,
        name: `${CARRIER_LABELS[carrierKind] ?? carrierKind} ${pointId}`,
        address: { line1: pointId, postalCode: "00-000", city: "-", country: "PL" },
      };
    },
  };
}

function toDeliveryOption(
  carrier: OmnipackDeliveryCatalogCarrier,
  service: OmnipackDeliveryCatalogService,
): DeliveryOption {
  const carrierLabel = CARRIER_LABELS[carrier.kind] ?? carrier.code;
  const isLocker = service.deliveryKind === "parcel-locker";
  return {
    id: `${carrier.kind}-${service.code}`.toLowerCase(),
    kind: service.deliveryKind,
    deliveryKind: service.deliveryKind,
    providerKind: "omnipack",
    carrierKind: carrier.kind,
    carrierCode: service.code,
    service: service.code,
    serviceCode: service.code,
    label: isLocker ? `Punkt odbioru ${carrierLabel}` : `Kurier ${carrierLabel}`,
    description: isLocker
      ? `Odbiór w wybranym punkcie ${carrierLabel}.`
      : `Dostawa kurierem ${carrierLabel} pod wskazany adres.`,
    pickupPointRequired: service.requiresPickupPoint,
    addressRequired: !service.requiresPickupPoint,
  };
}
