import type { SellableCatalogItem } from '@openlup/platform/catalog/contracts';

export type Locale = 'en' | 'pl';
export type Localized = Record<Locale, string>;
export type PurchaseMode = 'one_time' | 'subscription';

export interface Product extends SellableCatalogItem {
  slug: string;
  name: Localized;
  description: Localized;
  details: Localized;
  media: string;
  mediaAlt: Localized;
  contents: string;
}

/** Application-owned data, shared without translation between browser and host. */
export interface StoreConfig {
  id: string;
  brand: {
    name: string;
    strapline: Localized;
    description: Localized;
  };
  theme: {
    ink: string;
    paper: string;
    accent: string;
    accentInk: string;
    border: string;
  };
  copy: {
    heroTitle: Localized;
    heroBody: Localized;
    offerTitle: Localized;
    offerBody: Localized;
    shippingNote: Localized;
  };
  media: {
    hero: string;
    heroAlt: Localized;
  };
  market: {
    country: 'PL';
    currency: 'PLN';
    timezone: 'Europe/Warsaw';
    locales: readonly Locale[];
  };
  offer: {
    layout: 'cards' | 'list';
    products: readonly Product[];
    minUnits: number;
    maxUnits: number;
    shippingMinor: number;
    freeShippingFromMinor: number;
    subscriptionDiscountBps: number;
    cadenceDays: readonly number[];
    defaultCadenceDays: number;
  };
  legal: {
    revision: string;
    returnsDays: number;
    demoOnly: true;
  };
  features: {
    reviews: boolean;
    acquisition: boolean;
    research: boolean;
    partners: boolean;
    risk: false;
    normalizedIngest: boolean;
  };
}

export function assertConfig(config: StoreConfig): void {
  const offer = config.offer;
  if (typeof config.id !== 'string' || config.id.length > 80
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.id)) throw new Error('starter_configuration_invalid');
  if (!config.brand.name.trim() || !config.legal.demoOnly || config.features.risk !== false) {
    throw new Error('starter_configuration_invalid');
  }
  for (const token of Object.values(config.theme)) {
    if (!/^#[0-9a-f]{6}$/i.test(token)) throw new Error('starter_theme_invalid');
  }
  for (const amount of [offer.minUnits, offer.maxUnits, offer.shippingMinor,
    offer.freeShippingFromMinor, offer.subscriptionDiscountBps]) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('starter_offer_invalid');
  }
  if (offer.minUnits < 1 || offer.maxUnits < offer.minUnits || offer.maxUnits > 100
    || offer.subscriptionDiscountBps > 10000 || offer.cadenceDays.length === 0
    || !offer.cadenceDays.includes(offer.defaultCadenceDays)
    || offer.cadenceDays.some(day => !Number.isSafeInteger(day) || day < 1 || day > 366)) {
    throw new Error('starter_offer_invalid');
  }
  const seen = new Set<string>();
  const slugs = new Set<string>();
  if (offer.products.length === 0) throw new Error('starter_catalog_empty');
  for (const product of offer.products) {
    if (seen.has(product.sku) || slugs.has(product.slug)
      || !/^[A-Z0-9-]{1,80}$/.test(product.sku)
      || !/^[a-z0-9-]{1,80}$/.test(product.slug)
      || !Number.isSafeInteger(product.unitPrice.amountMinor)
      || product.unitPrice.amountMinor < 1
      || product.unitPrice.currency !== config.market.currency
      || product.permittedPurchaseModes.length === 0
      || product.permittedPurchaseModes.some(mode => mode !== 'one_time' && mode !== 'subscription')
      || !product.media.startsWith('/media/')) {
      throw new Error('starter_product_invalid');
    }
    seen.add(product.sku);
    slugs.add(product.slug);
  }
}
