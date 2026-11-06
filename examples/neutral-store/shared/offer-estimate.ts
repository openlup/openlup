import { deriveSubscriptionUnitPrice } from '@openlup/platform/pricing';
import type { PurchaseMode, StoreConfig } from './config.ts';
import type { CartLine } from './offer.ts';

/** Catalogue-only estimate from the package kernel. Native quotes own checkout money. */
export function estimateOffer(config: StoreConfig, mode: PurchaseMode, selected: readonly CartLine[]) {
  const lines = selected.map(({ sku, quantity }) => {
    const baseUnitMinor = config.offer.products.find(product => product.sku === sku)!.unitPrice.amountMinor;
    const unitMinor = mode === 'one_time' ? baseUnitMinor : deriveSubscriptionUnitPrice(baseUnitMinor, {
      discountBps: config.offer.subscriptionDiscountBps, roundingQuantumMinor: config.offer.subscriptionRoundingQuantumMinor, roundingRule: 'FLOOR_TO_QUANTUM' });
    return { sku, quantity, baseUnitMinor, unitMinor, lineMinor: unitMinor * quantity };
  });
  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineMinor, 0);
  const modeDiscountMinor = lines.reduce((sum, line) => sum + (line.baseUnitMinor - line.unitMinor) * line.quantity, 0);
  const shippingMinor = subtotalMinor >= config.offer.freeShippingFromMinor ? 0 : config.offer.shippingMinor;
  return { lines, subtotalMinor, modeDiscountMinor, discountMinor: 0, shippingMinor,
    totalMinor: subtotalMinor + shippingMinor, currency: config.market.currency };
}
