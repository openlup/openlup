import { priceInterimOffer } from '../shared/interim-pricing.ts';
import { assertConfig, type StoreConfig } from '../shared/config.ts';
import { demoIdentifier, editorDocuments, editorProducts } from '../host/editor-catalogue.ts';

/** Fictional application data only. Schema and business effects belong to installed packages. */
export function buildDemoSeed(config: StoreConfig) {
  assertConfig(config);
  const identifier = (kind: string, key: string) => demoIdentifier(config, kind, key);
  const catalogue = editorProducts(config), documents = editorDocuments(config);
  const listId = identifier('price-list', config.market.currency);
  const products = documents.map(({ variants, productId }) => ({
    id: productId, slug: `demo-${config.id}-${variants[0]!.slug}`,
    status: 'active', name: variants[0]!.name.en, description: variants[0]!.description.en,
  }));
  const skus = catalogue.map(product => ({
    id: identifier('sku', product.sku), product_id: identifier('product', product.groupKey),
    sku: product.sku, title: product.title, status: 'active', min_order_qty: 1,
    net_weight_g: product.physicalSize, is_addon: product.isAddon, sellable_standalone: product.permittedPurchaseModes.includes('one_time'),
    sellable_in_subscription: product.permittedPurchaseModes.includes('subscription'),
  }));
  const priceLists = [{ id: listId, name: `${config.brand.name} demonstration`,
    region_code: config.market.country, currency: config.market.currency, status: 'active',
    valid_from: '2000-01-01T00:00:00.000Z' }];
  const pricingConfig = { ...config, offer: { ...config.offer, products: catalogue } };
  const prices = catalogue.flatMap((product, index) => product.permittedPurchaseModes.map(mode => {
    const amount = priceInterimOffer(pricingConfig, mode, [{ sku: product.sku, quantity: 1 }]).lines[0]!.unitMinor;
    if (amount > 2147483647) throw new Error('starter_demo_price_out_of_range');
    if (amount < 1) throw new Error('starter_demo_price_not_payable');
    return { id: identifier('price', `${product.sku}:${mode}`), price_list_id: listId, variant_id: skus[index]!.id,
      mode, min_qty: 1, unit_price_minor: amount,
      amount_kind: 'gross', active: true, valid_from: '2000-01-01T00:00:00.000Z' };
  }));
  const settings = [
    { key: 'subscription_minimum_base_units', value: String(config.subscriptionEditing.minimumBaseUnits) },
    { key: 'subscription_sized_intro_phase', value: JSON.stringify({ fixedThroughCycle: config.subscriptionEditing.sized.fixedThroughCycle,
      graduationCycle: config.subscriptionEditing.sized.graduationCycle }) },
    { key: `starter_sized_subject:${config.id}`, value: JSON.stringify(config.subscriptionEditing.subject) },
  ];
  return { products, skus, priceLists, prices, documents, settings };
}
