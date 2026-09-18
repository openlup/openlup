import type { OfferPolicyReadinessPort } from "../../../domains/commerce/offerPolicyReadiness.js";

export interface OfferPolicyReadinessSupabaseClient {
  rpc(
    fn: string,
    args?: Record<string, never>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export function createSupabaseOfferPolicyReadinessPort(
  client: OfferPolicyReadinessSupabaseClient,
): OfferPolicyReadinessPort {
  return {
    async readOfferPolicyV2Readiness(): Promise<unknown> {
      const { data, error } = await client.rpc("commerce_offer_policy_v2_readiness");
      if (error) throw error instanceof Error ? error : new Error("offer_policy_readiness_failed");
      return data;
    },
  };
}
