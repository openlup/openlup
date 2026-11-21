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
  const invalid = (cause: string) => { throw new Error('starter_subscription_offer_invalid', { cause: `subscriptionOffers.<mode>.${cause}` }); };
  const integerRule = 'integers from 1 through 2147483647';
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
  const numbers = (domain: Numbers, path: string) => {
    if (!domain || (domain.kind !== 'set' && domain.kind !== 'range')) return invalid(`${path}: a set or range is required`);
    if (domain.kind === 'set') {
      if (!domain.values.length || !domain.values.every(positive) || new Set(domain.values).size !== domain.values.length) {
        invalid(`${path}: a nonempty set of distinct ${integerRule}`);
      }
    } else if (![domain.min,domain.max,domain.step].every(positive) || domain.max < domain.min) {
      invalid(`${path}: min, max and step must be ${integerRule}, with max at least min`);
    }
  };
  numbers(offer.days, 'days');
  if (maximum(offer.days) > MAX_CADENCE_DAYS) invalid(`days: maximum is ${MAX_CADENCE_DAYS}`);
  for (const path of ['checkoutDays', 'preferredDays'] as const) {
    const domain = offer[path];
    if (!domain) continue;
    numbers(domain, path);
    if (maximum(domain) > maximum(offer.days)) invalid(`${path}: maximum cannot exceed the maximum in days`);
    if (choices(domain).some(day => !contains(offer.days,day))) invalid(`${path}: every cadence must be in days`);
  }
  if (offer.checkoutMinimumBaseUnits !== undefined && !positive(offer.checkoutMinimumBaseUnits)) {
    invalid(`checkoutMinimumBaseUnits: use an integer from 1 through 2147483647`);
  }
  if (!contains(offer.days,offer.defaultDays) || !contains(offer.checkoutDays ?? offer.days,offer.defaultDays)) {
    invalid('defaultDays: use a cadence in days and in checkoutDays when supplied');
  }
  for (const path of ['minimumBaseUnits', 'maximumUnits', 'maximumBaseLines', 'maximumAddonLines'] as const) {
    if (!positive(offer[path])) invalid(`${path}: use an integer from 1 through 2147483647`);
  }
  if (offer.maximumUnits < offer.minimumBaseUnits) invalid('maximumUnits: must be at least minimumBaseUnits');
  if (offer.maximumBaseLines + offer.maximumAddonLines > MAX_CHECKOUT_LINES) {
    throw new Error('starter_lines_above_representation');
  }
  for (const [sku,rules] of Object.entries(offer.bySku)) {
    const path = `bySku.${sku}`;
    if (!skus.includes(sku)) invalid(`${path}: SKU must be in the editor catalogue`);
    if (!rules.length) invalid(`${path}: at least one rule is required`);
    const seen = new Set<number>();
    let index = 0;
    for (const rule of rules) {
      const days = `${path}.${index}.days`;
      numbers(rule.days, days);
      numbers(rule.quantities, `${path}.${index}.quantities`);
      if (maximum(rule.days) > maximum(offer.days)) invalid(`${days}: maximum cannot exceed the maximum in days`);
      if (maximum(rule.quantities) > MAX_CHECKOUT_LINE_QUANTITY) throw new Error('starter_units_above_representation');
      for (const day of choices(rule.days)) {
        if (!contains(offer.days,day)) invalid(`${days}: every cadence must be in days`);
        if (seen.has(day)) invalid(`${days}: cadence cannot repeat across rules for this SKU`);
        seen.add(day);
      }
      index += 1;
    }
  }
}
