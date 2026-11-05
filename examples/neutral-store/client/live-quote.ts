import type { Product } from '../shared/config.ts';
import type { Cart, OfferQuote } from '../shared/offer.ts';
import { isRecord } from '../shared/offer.ts';
import { quoteCopy } from '../owned/quote-copy.ts';
import type { PageContext } from './context.ts';
import { act } from './api.ts';
import { el } from './dom.ts';

/** Failed evidence never becomes a displayed zero or free delivery. */
export function isOfferQuoteView(input: unknown): input is OfferQuote & Record<string,unknown> {
  if (!isRecord(input) || !Array.isArray(input.lines) || !input.lines.length
    || !['one_time','subscription'].includes(String(input.mode)) || typeof input.currency !== 'string'
    || !['subtotalMinor','discountMinor','modeDiscountMinor','shippingMinor','totalMinor'].every(key =>
      typeof input[key] === 'number' && Number.isSafeInteger(input[key]) && (input[key] as number) >= 0)) return false;
  if (!input.lines.every(line => isRecord(line) && typeof line.sku === 'string'
    && ['quantity','baseUnitMinor','unitMinor','lineMinor'].every(key => typeof line[key] === 'number' && Number.isSafeInteger(line[key]) && (line[key] as number) >= 0)
    && (line.quantity as number) > 0 && line.lineMinor === (line.quantity as number) * (line.unitMinor as number))) return false;
  return input.lines.reduce((sum,line) => sum + line.lineMinor,0) === input.subtotalMinor
    && (input.subtotalMinor as number) - (input.discountMinor as number) + (input.shippingMinor as number) === input.totalMinor;
}

const generations = new WeakMap<HTMLElement, number>();
export function clearLiveQuote(target: HTMLElement): void {
  generations.set(target,(generations.get(target) ?? 0) + 1);
}
/** Display native mode prices; a failed refresh withholds the previous amount. */
export async function refreshLiveQuote(context: PageContext, cart: Cart, target: HTMLElement,
  render: (quote: OfferQuote) => void): Promise<void> {
  clearLiveQuote(target); const own = generations.get(target);
  target.replaceChildren(el('p', {},quoteCopy[context.locale].loading));
  const result = await act('offer.validate',{ cart,acquisitionCapability: 'subscription-acquisition.v1' },crypto.randomUUID());
  if (generations.get(target) !== own || !target.isConnected) return;
  if (!result.ok || !isOfferQuoteView(result.value)
    || result.value.currency !== context.config.market.currency) {
    target.replaceChildren(el('p', {},quoteCopy[context.locale].unavailable)); return;
  }
  render(result.value as unknown as OfferQuote);
}
export function nativeUnitPrice(context: PageContext, product: Product): HTMLElement {
  const target = el('div', { class: 'price', 'aria-live': 'polite' });
  const mode = context.getCart().mode;
  const cart: Cart = { schemaVersion: 1,configuration: context.config.id,mode,
    cadenceDays: mode === 'subscription' ? context.config.offer.defaultCadenceDays : null,
    lines: [{ sku: product.sku,quantity: context.config.offer.minUnits }] };
  queueMicrotask(() => { if (target.isConnected) void refreshLiveQuote(context,cart,target,quote => {
    const line = quote.lines.find(item => item.sku === product.sku);
    target.replaceChildren(el('span', {},line && Number.isSafeInteger(line.unitMinor)
      ? context.money(line.unitMinor) : quoteCopy[context.locale].unavailable));
  }); });
  return target;
}
