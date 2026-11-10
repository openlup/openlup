import type { Product } from '../shared/config.ts';
import type { EditorProduct, SubscriptionEditorConfig } from '../shared/subscription-edit.ts';

/** Synthetic fixtures: coverage is an illustrative unit calculation, never usage advice. */
export function subscriptionEditing(products: readonly Product[]): SubscriptionEditorConfig {
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
  return { minimumBaseUnits: 6, planDays: [14, 28, 56], maximumBaseLines: 6, maximumAddonLines: 12, maximumQuantity: 99,
    sized: { minimumCoreUnits: 6, maximumCoreLines: 6, maximumAddonLines: 12, maximumQuantity: 99,
      allowedCadences: [14, 28, 56], maximumExclusions: 32, maximumCatalogExclusions: 32,
      fixedThroughCycle: 2, graduationCycle: 3, preferredSize: 250, nominalSizes: [250, 500],
      portionModes: { full: { mode: 'full', factor: 1 }, reduced: { mode: 'reduced', factor: 0.5 } } },
    subject: { revision: 1, dailyNeed: 20, currentExclusions: [], inheritedExclusions: ['demo-restricted'] }, catalogue };
}
