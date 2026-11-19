import type { CatalogConformanceSubject } from '@openlup/platform/catalog/testing';
import { supplementsCatalogue } from './catalogue.ts';
import { itemType, pack } from './pack.ts';
import { cadenceDays, demandFor, policy } from './policy.ts';

const v1 = pack.types[0];
const updatedType = { ...itemType, version: 2 } as const;
export const upgrade = {
  pack: { ...pack, version: 2, types: [v1, { ...v1, version: updatedType.version, attributes: [
    ...v1.attributes,
    { key: 'label_language', scope: 'product', valueType: { kind: 'enum', values: [{ id: 'en' }] },
      required: true, cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true,
      displayOrder: 2, labels: { en: 'Label language' } },
  ] }] },
  productAttributes: { adults_only: true, label_language: 'en' },
  retainedType: itemType,
  updatedType,
} as const;

export function supplementsFixtures(priceListId: string) {
  const { initialDrafts, initialPublications, successor, withdrawal } = supplementsCatalogue(priceListId);
  const purchase = {
    lines: initialDrafts.map(({ skuId, format, netContent }) => ({
      id: skuId, type: itemType, quantity: 1, demand: demandFor(format, netContent),
    })),
    adultAttestation: true,
    cadenceDays,
  };

  const agreedTerms = {
    currency: 'XTS',
    currencyExponent: 2,
    effectiveAt: '2026-11-19T12:00:00.000Z',
    priceListId,
    pricePhase: 'base',
    purchaseMode: 'subscription',
    minimumQuantity: 1,
    discountBps: 0,
    roundingQuantumMinor: 10,
    shippingMinor: 0,
    taxMinor: 0,
    firstCycleAnchor: '2026-11-19T12:00:00.000Z',
    renewalCycleAnchor: '2026-12-17T12:00:00.000Z',
    followingCycleAnchor: '2027-01-14T12:00:00.000Z',
    cadenceDays,
    purchase: { skuIds: [initialDrafts[0].skuId, initialDrafts[1].skuId], quantities: [1, 1],
      unitAmountsMinor: [2800, 4200], totalMinor: 7000 },
    renewal: { skuIds: [initialDrafts[0].skuId, initialDrafts[1].skuId], quantities: [1, 1],
      unitAmountsMinor: [2800, 4200], totalMinor: 7000 },
    successor: { predecessorSkuId: initialDrafts[0].skuId, successorSkuId: successor.skuId, requiresExplicitConsent: true,
      oldAmountMinor: 2800, newAmountMinor: 3080, oldTotalMinor: 7000, newTotalMinor: 7280 },
  } as const;

  const records = [...initialDrafts, successor];
  const fixtures = {
    drafts: [...initialDrafts.map(({ payload }) => payload), ...initialPublications, withdrawal, successor.payload],
    quantities: records.map(({ netContent: value }) => ({
      type: itemType, value, ...(value.dimension === 'mass' && { targetUnit: 'openlup:g' }),
    })),
    attributes: records.map(({ skuId, format, payload }) => ({ type: itemType,
      input: { productAttributes: payload.product.attributes ?? {}, skus: [{ id: skuId, attributes: { format } }] },
      publicationRevision: '1',
    })),
    combinations: records.map(({ skuId, format }) => ({ type: itemType, input: {
      axes: ['format'], typed: true, retained: [],
      incoming: [{ skuId, state: 'active', optionValues: { format: { kind: 'choice', value: format } } }],
    } })),
    refusals: [{ name: 'subscription with prepaid requested', capability: 'prepaid',
      expectedCode: 'prepaid_unsupported', observedCode: 'prepaid_unsupported', zeroEffects: true }],
    profileChecks: [{ cadenceDays, lines: purchase.lines }],
    profilePolicies: [policy],
  } satisfies Omit<CatalogConformanceSubject['packs'][number], 'pack'> & {
    profileChecks: { cadenceDays: number; lines: typeof purchase.lines }[];
    profilePolicies: typeof policy[];
  };

  return { purchase, agreedTerms, fixtures };
}

export const requiredChecks = [
  'quantities', 'attribute-values', 'variant-combinations', 'draft-content', 'profiles', 'owner-refusals',
];
