import type { Product } from '../shared/config.ts';
import type { OfferQuote } from '../shared/offer.ts';
import { priceInterimOffer } from '../shared/interim-pricing.ts';
import type { PageContext } from '../client/context.ts';
import { el, link } from '../client/dom.ts';
import { productPath, routes } from '../shared/routes.ts';

/** Three ordinary functions, not a component registry or extension runtime. */
export interface CustomizationFragments {
  offerIntro(context: PageContext): HTMLElement;
  productCard(context: PageContext, product: Product): HTMLElement;
  checkoutSummary(context: PageContext, quote: OfferQuote): HTMLElement;
}

export const fragments: CustomizationFragments = {
  offerIntro(context) {
    return el('section', { class: 'offer-intro' },
      el('h2', {}, context.config.copy.offerTitle[context.locale]),
      el('p', {}, context.config.copy.offerBody[context.locale]),
      link(context.t('builder'), routes.builder[context.locale], 'button-link'));
  },
  productCard(context, product) {
    return el('article', { class: 'product-card' },
      el('img', { src: product.media, alt: product.mediaAlt[context.locale], width: 320, height: 320, loading: 'lazy' }),
      el('div', {},
        el('h3', {}, product.name[context.locale]),
        el('p', {}, product.description[context.locale]),
        el('p', { class: 'price' }, context.money(priceInterimOffer(context.config, context.getCart().mode, [{ sku: product.sku, quantity: 1 }]).lines[0]!.unitMinor)),
        link(context.t('details'), productPath(product.slug, context.locale))));
  },
  checkoutSummary(context, quote) {
    const row = (label: string, value: number) => el('div', {},
      el('dt', {}, label), el('dd', {}, context.money(value)));
    return el('aside', { class: 'summary', 'aria-label': context.t('boxSummary') },
      el('h2', {}, context.t('boxSummary')),
      el('dl', {}, row(context.t('subtotal'), quote.subtotalMinor),
        row(context.t('discount'), -quote.discountMinor),
        row(context.t('shipping'), quote.shippingMinor),
        row(context.t('total'), quote.totalMinor)),
      quote.modeDiscountMinor ? el('p', {}, `${context.t('modePriceBenefit')}: ${context.money(quote.modeDiscountMinor)}`) : null,
      el('p', { class: 'muted' }, context.t('authoritative')));
  },
};
