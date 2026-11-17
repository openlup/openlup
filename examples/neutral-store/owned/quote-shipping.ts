import { createQuoteShippingPromotions, type QuoteShippingPromotionsDeps } from '@openlup/platform/promotions';
import type { CreateQuoteRequest } from '@openlup/platform/pricing';
import type { StoreConfig } from '../shared/config.ts';

/** Application-owned shipping composition; keep carrier configuration and adapters here. */
export function createQuoteShipping<Request extends CreateQuoteRequest & { visitorId?: string }>(
  config: StoreConfig,
  deps: Omit<QuoteShippingPromotionsDeps<Request>, 'commerceSettingsPort'>,
  resolver?: ReturnType<typeof createQuoteShippingPromotions<Request>>['resolveQuoteShippingPromotions'],
): ReturnType<typeof createQuoteShippingPromotions<Request>> {
  if (resolver) return { resolveQuoteShippingPromotions: resolver };
  return createQuoteShippingPromotions({ ...deps,
    commerceSettingsPort: { getShippingSettings: async () => ({ legacyFlatMinor: 0, policy: { version: 'shipping-policy.v1',
      current: { enabled: true, flatMinor: config.offer.shippingMinor, freeThresholdMinor: config.offer.freeShippingFromMinor,
        effectiveFrom: config.quote.policy.effectiveFrom } } }) } });
}
