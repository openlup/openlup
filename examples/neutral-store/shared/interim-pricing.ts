import type { PurchaseMode, StoreConfig } from './config.ts';
import type { CartLine } from './offer.ts';

/** Temporary mode-price composition; replace this function with the installed quote engine. */
export function priceInterimOffer(config: StoreConfig, mode: PurchaseMode, selected: readonly CartLine[]) {
  const lines = selected.map(({ sku, quantity }) => {
    const baseUnitMinor = config.offer.products.find(product => product.sku === sku)!.unitPrice.amountMinor;
    const quantum = BigInt(config.offer.subscriptionRoundingQuantumMinor);
    const unitMinor = mode === 'one_time' ? baseUnitMinor : Number(
      ((BigInt(baseUnitMinor) * BigInt(10000 - config.offer.subscriptionDiscountBps)) / 10000n / quantum) * quantum);
    return { sku, quantity, baseUnitMinor, unitMinor, lineMinor: unitMinor * quantity };
  });
  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineMinor, 0);
  const modeDiscountMinor = lines.reduce((sum, line) => sum + (line.baseUnitMinor - line.unitMinor) * line.quantity, 0);
  const shippingMinor = subtotalMinor >= config.offer.freeShippingFromMinor ? 0 : config.offer.shippingMinor;
  return { lines, subtotalMinor, modeDiscountMinor, discountMinor: 0, shippingMinor,
    totalMinor: subtotalMinor + shippingMinor, currency: config.market.currency };
}
