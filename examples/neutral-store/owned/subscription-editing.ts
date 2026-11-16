import { assertSubscriptionOffer, choices, type SubscriptionOffers } from '../shared/subscription-offer.ts';
import type { Product } from '../shared/config.ts';
import type { EditorProduct, SubscriptionEditorConfig } from '../shared/subscription-edit.ts';

/** Synthetic fixtures: coverage is an illustrative unit calculation, never usage advice. */
export function subscriptionEditing(products: readonly Product[], offers: SubscriptionOffers): SubscriptionEditorConfig {
  const catalogue: EditorProduct[] = products.flatMap((product, index) => {
    const primary: EditorProduct = { ...product, groupKey: product.sku, physicalSize: 250, demandPerUnit: 40,
      exclusions: index === 2 ? ['demo-restricted'] : [], isAddon: false,stockQuantity: 1000 };
    return [primary, { ...primary, sku: `${product.sku}-L`, slug: `${product.slug}-large`,
      physicalSize: 500, demandPerUnit: 80, contents: '500 g',
      unitPrice: { ...product.unitPrice, amountMinor: product.unitPrice.amountMinor * 2 } }];
  });
  const basis = products[0]!;
  catalogue.push({ ...basis, sku: `${basis.sku}-EXTRA`, slug: `${basis.slug}-extra`,
    title: 'Extra container', name: { en: 'Extra container', pl: 'Dodatkowy pojemnik' },
    description: { en: 'A fictional optional extra.', pl: 'Fikcyjny dodatek opcjonalny.' },
    groupKey: `${basis.sku}-EXTRA`, physicalSize: 100, demandPerUnit: 10, exclusions: [], isAddon: true,stockQuantity: 1000,
    contents: '100 g', unitPrice: { ...basis.unitPrice, amountMinor: 500 } });
  for (const offer of Object.values(offers)) assertSubscriptionOffer(offer,catalogue.map(product => product.sku));
  const maximumQuantity = (offer: SubscriptionOffers['classic']) => Math.max(1,...Object.values(offer.bySku)
    .flatMap(rules => rules.flatMap(rule => choices(rule.quantities))));
  return { minimumBaseUnits: offers.classic.minimumBaseUnits, planDays: choices(offers.classic.preferredDays ?? offers.classic.days),
    maximumBaseLines: offers.classic.maximumBaseLines, maximumAddonLines: offers.classic.maximumAddonLines, maximumQuantity: maximumQuantity(offers.classic),
    sized: { offer: offers.sized, minimumCoreUnits: offers.sized.minimumBaseUnits, maximumCoreLines: offers.sized.maximumBaseLines,
      maximumAddonLines: offers.sized.maximumAddonLines, maximumQuantity: maximumQuantity(offers.sized),
      allowedCadences: choices(offers.sized.days), maximumExclusions: 32, maximumCatalogExclusions: 32,
      fixedThroughCycle: 2, graduationCycle: 3, preferredSize: 250, nominalSizes: [250, 500],
      portionModes: { full: { mode: 'full', factor: 1 }, reduced: { mode: 'reduced', factor: 0.5 } } },
    subject: { revision: 1, dailyNeed: 20, currentExclusions: [], inheritedExclusions: ['demo-restricted'] }, catalogue };
}
