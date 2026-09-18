import { useEffect, useState } from "react";

import { offerPolicyV2CapabilityEnabled } from "@/lib/flags";
import { getOrCreateVisitorId } from "@/lib/commerceVisitorId";
import { getCommerceOfferPricing } from "./commerceClient";
import { OFFER_POLICY_V2_CAPABILITY } from "./offerPolicyContracts";
import type { CommerceOfferPricingResponse } from "./offerPricingContracts";

export interface CommerceOfferPricingState {
  loading: boolean;
  available: boolean;
  data: CommerceOfferPricingResponse | null;
}

/**
 * Read-only marketing projection. Failure deliberately yields no amount; it
 * never falls back to static catalog copy or participates in checkout.
 */
export function useCommerceOfferPricing(): CommerceOfferPricingState {
  const [state, setState] = useState<CommerceOfferPricingState>({
    loading: true,
    available: false,
    data: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const visitorId = getOrCreateVisitorId();
    const headers = offerPolicyV2CapabilityEnabled() && visitorId
      ? {
          "x-commerce-offer-policy-capability": OFFER_POLICY_V2_CAPABILITY,
          "x-commerce-visitor-id": visitorId,
        }
      : undefined;
    getCommerceOfferPricing({ signal: controller.signal, headers })
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ loading: false, available: true, data });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ loading: false, available: false, data: null });
        }
      });
    return () => controller.abort();
  }, []);

  return state;
}
