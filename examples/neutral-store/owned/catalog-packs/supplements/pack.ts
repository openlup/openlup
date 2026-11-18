import { defineCatalogPack } from '@openlup/platform/catalog';
import { cadenceDays, formats, policy, units, validateContent } from './policy.ts';

export const itemType = { key: 'supplements:item', version: 1 } as const;
export const profileRef = { key: 'supplements:regular', version: 1 } as const;
export const taxClass = 'reduced-supplement';
export const swapGroupKey = 'supplements:capsules';

export const pack = defineCatalogPack({
  id: 'supplements',
  namespace: 'supplements',
  version: 1,
  openlupRange: '^1.3.0',
  capabilities: { quantities: true, attributes: true, combinations: true, sharedContent: true, profiles: true, prepaid: false },
  taxClasses: [{ key: taxClass }],
  subscriptionProfiles: [profileRef],
  subscriptionProfileDefinitions: [{
    ...profileRef,
    allowedCadenceDays: [cadenceDays],
    quantities: { minBaseUnits: 2, maxBaseUnits: 2, maxUnitsPerLine: 1, maxBaseLines: 2 },
    addons: { allowedTypeRefs: [], maxLines: 0, maxUnits: 0 },
    swapGroupKeys: [swapGroupKey],
    consumption: { kind: 'units_per_day', demandUnit: 'per_line', demandScope: { kind: 'per_line' }, policyRef: policy.ref },
    prepaid: 'unsupported',
  }],
  types: [{
    ...itemType,
    validatorRef: 'sha256:65073277f001b184be7afa5873795c934b43cc2dce291bdd11ac3ded9aac7f0b',
    validateContent,
    units,
    netContentUnits: ['supplements:capsule', 'openlup:g'],
    dimensions: [{ key: 'format', kind: 'choice', values: formats }],
    axes: [{ key: 'format', attributeKey: 'format' }],
    attributes: [
      { key: 'format', scope: 'variant', valueType: { kind: 'enum', values: [{ id: 'capsule' }, { id: 'powder' }] },
        required: true, cardinality: { min: 1, max: 1 }, filterable: true, facetable: true, public: true,
        displayOrder: 0, labels: { en: 'Format' } },
      { key: 'adults_only', scope: 'product', valueType: { kind: 'boolean' }, required: true,
        cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true,
        displayOrder: 1, labels: { en: '18+' } },
    ],
    subscriptionProfileRef: profileRef,
    taxClass,
  }],
});
