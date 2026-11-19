import { MAX_CADENCE_DAYS } from '@openlup/core/subscription';
import { contains, choices, maximum, type Numbers } from './policy.ts';
export { set, range, contains, choices, maximum, type Numbers } from './policy.ts';

// Mirror checkoutCommandSchemas.ts's private transport bounds for startup validation.
const MAX_CHECKOUT_LINE_QUANTITY = 99;
const MAX_CHECKOUT_LINES = 50;

export interface SubscriptionOffer {
  days: Numbers;
  checkoutDays?: Numbers;
  preferredDays?: Numbers;
  checkoutMinimumBaseUnits?: number;
  defaultDays: number;
  minimumBaseUnits: number;
  maximumUnits: number;
  maximumBaseLines: number;
  maximumAddonLines: number;
  bySku: Readonly<Record<string, readonly { days: Numbers; quantities: Numbers }[]>>;
}
export type SubscriptionOffers = { classic: SubscriptionOffer; sized: SubscriptionOffer };
export function quantityChoices(offer: SubscriptionOffer, sku: string, days: number): number[] {
  if (!contains(offer.days,days)) return [];
  return [...new Set((Object.hasOwn(offer.bySku,sku) ? offer.bySku[sku]! : [])
    .filter(rule => contains(rule.days,days)).flatMap(rule => choices(rule.quantities)))].sort((a,b) => a-b);
}
export function admitsLine(offer: SubscriptionOffer, sku: string, days: number, quantity: number): boolean {
  return contains(offer.days,days) && Object.hasOwn(offer.bySku,sku) && offer.bySku[sku]!.some(rule => contains(rule.days,days) && contains(rule.quantities,quantity));
}
export function admitsTerms(offer: SubscriptionOffer, days: number,
  base: readonly { sku: string; qty: number }[], addons: readonly { sku: string; qty: number }[] = []): boolean {
  return contains(offer.days,days) && base.length > 0 && base.length <= offer.maximumBaseLines && addons.length <= offer.maximumAddonLines
    && base.reduce((sum,line) => sum+line.qty,0) >= offer.minimumBaseUnits
    && [...base,...addons].reduce((sum,line) => sum+line.qty,0) <= offer.maximumUnits
    && [...base,...addons].every(line => admitsLine(offer,line.sku,days,line.qty));
}
export function assertSubscriptionOffer(offer: SubscriptionOffer, skus: readonly string[]): void {
  const invalid = () => { throw new Error('starter_subscription_offer_invalid'); };
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
  const numbers = (domain: Numbers) => {
    if (!domain || (domain.kind !== 'set' && domain.kind !== 'range')) return invalid();
    if (domain.kind === 'set') {
      if (!domain.values.length || !domain.values.every(positive) || new Set(domain.values).size !== domain.values.length) invalid();
    } else if (![domain.min,domain.max,domain.step].every(positive) || domain.max < domain.min) invalid();
  };
  numbers(offer.days);
  if (maximum(offer.days) > MAX_CADENCE_DAYS) invalid();
  for (const domain of [offer.checkoutDays,offer.preferredDays]) if (domain) {
    numbers(domain); if (maximum(domain) > maximum(offer.days)) invalid();
    if (choices(domain).some(day => !contains(offer.days,day))) invalid();
  }
  if (offer.checkoutMinimumBaseUnits !== undefined && !positive(offer.checkoutMinimumBaseUnits)) invalid();
  if (!contains(offer.days,offer.defaultDays) || !contains(offer.checkoutDays ?? offer.days,offer.defaultDays)
    || ![offer.minimumBaseUnits,offer.maximumUnits,offer.maximumBaseLines,offer.maximumAddonLines].every(positive)
    || offer.maximumUnits < offer.minimumBaseUnits) invalid();
  if (offer.maximumBaseLines + offer.maximumAddonLines > MAX_CHECKOUT_LINES) {
    throw new Error('starter_lines_above_representation');
  }
  for (const [sku,rules] of Object.entries(offer.bySku)) {
    if (!skus.includes(sku) || !rules.length) invalid();
    const seen = new Set<number>();
    for (const rule of rules) {
      numbers(rule.days); numbers(rule.quantities);
      if (maximum(rule.days) > maximum(offer.days)) invalid();
      if (maximum(rule.quantities) > MAX_CHECKOUT_LINE_QUANTITY) throw new Error('starter_units_above_representation');
      for (const day of choices(rule.days)) {
        if (!contains(offer.days,day) || seen.has(day)) invalid();
        seen.add(day);
      }
    }
  }
}
