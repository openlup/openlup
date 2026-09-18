// Composition root for pickup-point search (BFF may construct server/infra).
// Maps a request's carrier kind to its point source and filters to the
// OMNIPACK_ENABLED_CARRIERS allowlist. InPost uses the token-free public ShipX
// points API; Orlen Paczka and others resolve to an empty result until their
// point API is wired (never an error).
import { createInpostPointsClient } from "../../infra/inpost/pointsClient.js";
import { resolveDeliverySelectionPort } from "./deliverySelectionFactory.js";
import type { PickupPointSearchPort } from "../../domains/shipping/pickupPointSearchPort.js";

export function createPickupPointSearchPort(
  env: Record<string, string | undefined> = process.env,
): PickupPointSearchPort {
  const enabled = new Set(resolveDeliverySelectionPort(env).enabledCarriers);
  const inpost = createInpostPointsClient({ baseUrl: env.INPOST_POINTS_API_BASE_URL });

  return {
    async searchPickupPoints(request) {
      if (!enabled.has(request.carrierKind)) return [];
      if (request.carrierKind === "inpost") {
        const points = await inpost.search({
          latitude: request.latitude,
          longitude: request.longitude,
          postalCode: request.postalCode,
          city: request.city,
          query: request.query,
          limit: request.limit,
        });
        return points.map((point) => ({ ...point, carrierKind: "inpost" }));
      }
      // orlen + others: point API not yet wired (token/credentials pending).
      return [];
    },
  };
}
