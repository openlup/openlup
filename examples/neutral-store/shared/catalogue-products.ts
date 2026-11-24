import type { PublishedCatalogOfferPage } from '@openlup/platform/catalog';
import type { Product, PurchaseMode, StoreConfig } from './config.ts';
import { mapStarterPresentation } from './catalogue-presentation.ts';
import { canCheckoutSubscriptionSku } from './offer.ts';

type PublishedSku = PublishedCatalogOfferPage['products'][number]['skus'][number];
export type StarterCatalogueItem = Product & {
  variantTitle?: string;
  minQuantity?: number;
  attributes?: PublishedSku['attributes'];
  physical: Product['physical'] & { primaryUnitIdentifier: PublishedSku['primaryUnitIdentifier'] | Product['physical']['primaryUnitIdentifier'] };
};
const positiveInt32 = (value: number) => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

export function readStarterProducts(page: PublishedCatalogOfferPage, config: StoreConfig) {
  const products: StarterCatalogueItem[] = [];
  const exclusions: Array<{ code: 'starter_catalogue_presentation_invalid' | 'starter_catalogue_price_missing'
    | 'starter_catalogue_price_basis_unsupported'; subject: string }> = [];
  for (const { slug, presentation, attributes, skus } of page.products) {
    const copy = mapStarterPresentation(presentation);
    for (const { skuCode: sku, title: variantTitle, price: { oneTime }, netContent, primaryUnitIdentifier, minQuantity,
      attributes: variantAttributes, sell } of skus) {
      if (!copy) { exclusions.push({ code: 'starter_catalogue_presentation_invalid', subject: sku }); continue; }
      if (!oneTime) { exclusions.push({ code: 'starter_catalogue_price_missing', subject: sku }); continue; }
      if (oneTime.amountBasis !== 'tax_inclusive' || oneTime.currency !== config.market.currency || !positiveInt32(oneTime.amountMinor)) {
        exclusions.push({ code: 'starter_catalogue_price_basis_unsupported', subject: sku }); continue;
      }
      if (!positiveInt32(minQuantity)) continue;
      const permittedPurchaseModes: PurchaseMode[] = [];
      if (sell.oneTime) permittedPurchaseModes.push('one_time');
      if (sell.subscription && canCheckoutSubscriptionSku(config, sku, minQuantity)) permittedPurchaseModes.push('subscription');
      if (!permittedPurchaseModes.length) continue;
      products.push({ ...copy, slug, sku, variantTitle, minQuantity, attributes: { ...attributes, ...variantAttributes },
        physical: { netContent, primaryUnitIdentifier }, unitPrice: { amountMinor: oneTime.amountMinor, currency: oneTime.currency },
        permittedPurchaseModes });
    }
  }
  return { products, exclusions };
}

export function publishedToStarterProducts(page: PublishedCatalogOfferPage, config: StoreConfig): StarterCatalogueItem[] {
  return readStarterProducts(page, config).products;
}

export function selectCatalogueProduct(products: readonly StarterCatalogueItem[], slug: string, sku: string | null) {
  if (sku === null) return products.find(product => product.slug === slug);
  const matches = products.filter(product => product.slug === slug && product.sku === sku);
  return matches.length === 1 ? matches[0] : undefined;
}
