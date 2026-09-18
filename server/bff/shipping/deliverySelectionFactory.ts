// Composition root for the delivery-selection port (BFF layer may construct
// server/infra). Resolution order (fail-safe):
//  1. valid OMNIPACK_MERCHANT_DICTIONARY_JSON -> dictionary-driven options
//     filtered by the OMNIPACK_ENABLED_CARRIERS allowlist (canonical path).
//  3. otherwise                               -> the DECLARED PRODUCTION CARRIER SET
//     (`OMNIPACK_DELIVERY_OPTIONS`). This is the posture production runs in
//     today: every declared route is intentionally enabled, declared in code,
//     and needs no env var to be offered.
//
// Allowlist semantics differ between (2) and (3) ON PURPOSE:
//  - (2) the merchant dictionary may carry the provider's entire portfolio, so
//    the allowlist is REQUIRED there; unset => fail-closed.
//  - (3) the code IS the merchant-confirmed list, so unset/empty => every
//    declared option. When set, the var can only NARROW that set (the operator
//    kill-switch the fulfillment integration doc promises: pull one carrier
//    without a code change). It can never widen it.
//  ⛔ Do not "unify" these by making (3) fail-closed: production leaves the
//  allowlist unset, so that would drop checkout to zero delivery options.
import { OMNIPACK_DELIVERY_CARRIER_KINDS } from "../../../src/domains/shipping/deliverySelectionContracts.js";
import { createStaticDeliverySelectionPort } from "../../domains/shipping/staticDeliverySelectionPort.js";
import { createDictionaryDeliverySelectionPort } from "../../domains/shipping/dictionaryDeliverySelectionPort.js";
import type { DeliverySelectionPort } from "../../domains/shipping/deliverySelectionPort.js";
import { createInpostPointsClient } from "../../infra/inpost/pointsClient.js";
import {
  loadOmnipackMerchantDictionary,
  readOmnipackEnabledCarriers,
} from "../../infra/omnipack/loadMerchantDictionary.js";

export interface DeliverySelectionPortResolution {
  port: DeliverySelectionPort;
  source: "dictionary" | "static_accepted_catalog";
  enabledCarriers: string[];
}

export function resolveDeliverySelectionPort(
  env: Record<string, string | undefined> = process.env,
): DeliverySelectionPortResolution {
  const requested = readOmnipackEnabledCarriers(env);

  const loaded = loadOmnipackMerchantDictionary(env);
  if (loaded.ok && loaded.dictionary) {
    return {
      port: createDictionaryDeliverySelectionPort({ dictionary: loaded.dictionary, enabledCarriers: requested }),
      source: "dictionary",
      enabledCarriers: [...requested],
    };
  }

  // Narrowing only: an explicit allowlist may remove carriers from the declared
  // set, never add one. Unknown/misspelled kinds simply match nothing.
  const declared = OMNIPACK_DELIVERY_CARRIER_KINDS;
  const enabledCarriers = requested.size === 0 ? [...declared] : declared.filter((kind) => requested.has(kind));

  return {
    port: createStaticDeliverySelectionPort({
      dhlOnly: false,
      enabledCarriers: requested.size === 0 ? undefined : new Set(enabledCarriers),
    }),
    source: "static_accepted_catalog",
    enabledCarriers,
  };
}

export function createDeliverySelectionPort(
  env: Record<string, string | undefined> = process.env,
): DeliverySelectionPort {
  return resolveDeliverySelectionPort(env).port;
}

// Composition root used by the hidden delivery-selection routes. Wraps the
// resolved port so that InPost pickup-point validation confirms the chosen
// locker code against ShipX (exists + Operating + canonical address) instead of
// trusting the browser-supplied string. Non-InPost carriers and listOptions are
// delegated unchanged. When InPost is not an enabled carrier, the base port is
// returned as-is (no InPost network dependency introduced).
export function createValidatedDeliverySelectionPort(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): DeliverySelectionPort {
  const resolution = resolveDeliverySelectionPort(env);
  if (!resolution.enabledCarriers.includes("inpost")) return resolution.port;
  const inpost = createInpostPointsClient({ baseUrl: env.INPOST_POINTS_API_BASE_URL }, fetchImpl);
  return withInpostPickupPointValidation(resolution.port, inpost);
}

function withInpostPickupPointValidation(
  base: DeliverySelectionPort,
  inpost: { getById(code: string): Promise<{
    id: string;
    name: string;
    address: { line1: string; postalCode: string; city: string; country: "PL" };
  } | null> },
): DeliverySelectionPort {
  return {
    listOptions: () => base.listOptions(),
    async validatePickupPoint(input) {
      if (input.carrierKind !== "inpost") return base.validatePickupPoint(input);
      const code = input.pointId.trim();
      if (!code) return null;
      const point = await inpost.getById(code);
      if (!point) return null;
      return { id: point.id, provider: "inpost", name: point.name, address: point.address };
    },
  };
}
