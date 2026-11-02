import { createHash } from 'node:crypto';
import { assertConfig, type StoreConfig } from '../shared/config.ts';

/** Fictional application data only. Schema and business effects belong to installed packages. */
export function buildDemoSeed(config: StoreConfig) {
  assertConfig(config);
  const identifier = (kind: string, key: string) => {
    const hex = createHash('sha256').update(`neutral-store-demo-v1:${config.id}:${kind}:${key}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const listId = identifier('price-list', config.market.currency);
  const products = config.offer.products.map(product => ({
    id: identifier('product', product.sku), slug: `demo-${config.id}-${product.slug}`,
    status: 'active', name: product.name.en, description: product.description.en,
  }));
  const skus = config.offer.products.map((product, index) => ({
    id: identifier('sku', product.sku), product_id: products[index]!.id,
    sku: product.sku, title: product.title, status: 'active', min_order_qty: 1,
    is_addon: false, sellable_standalone: product.permittedPurchaseModes.includes('one_time'),
    sellable_in_subscription: product.permittedPurchaseModes.includes('subscription'),
  }));
  const priceLists = [{ id: listId, name: `${config.brand.name} demonstration`,
    region_code: config.market.country, currency: config.market.currency, status: 'active',
    valid_from: '2000-01-01T00:00:00.000Z' }];
  const prices = config.offer.products.map((product, index) => {
    if (product.unitPrice.amountMinor > 2147483647) throw new Error('starter_demo_price_out_of_range');
    return { id: identifier('price', product.sku), price_list_id: listId, variant_id: skus[index]!.id,
      mode: 'any', min_qty: 1, unit_price_minor: product.unitPrice.amountMinor,
      amount_kind: 'gross', active: true, valid_from: '2000-01-01T00:00:00.000Z' };
  });
  return { products, skus, priceLists, prices };
}
