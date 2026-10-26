import type { SupabaseClient } from "@supabase/supabase-js";
import { createOfferAvailabilityPort, type OfferAvailabilityQueryClient } from "@openlup/platform/commerce/server";
import type { CommerceOfferAvailabilityPort } from "@openlup/platform/commerce/contracts";

export type OfferAvailabilitySupabaseClient = OfferAvailabilityQueryClient;

export function createSupabaseOfferAvailabilityPort(
  client: OfferAvailabilitySupabaseClient,
  options: { lowStockThreshold?: number; now?: () => Date } = {},
): CommerceOfferAvailabilityPort {
  return createOfferAvailabilityPort(client, {
    ...options, isStockProvider: providerKind => providerKind === "omnipack",
  });
}

/** Generated SDK narrowing belongs to the reference adapter. */
export function createSupabaseOfferAvailabilityPortFromClient(
  client: SupabaseClient,
): CommerceOfferAvailabilityPort {
  return createSupabaseOfferAvailabilityPort({
    from(table) {
      return client.from(table) as unknown as ReturnType<OfferAvailabilitySupabaseClient["from"]>;
    },
  });
}
