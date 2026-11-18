import { createHash } from 'node:crypto';
import { canonicalizeCatalogQuantity, type CatalogQuantity } from '@openlup/core/catalog';
import { canonicalCatalogDraftJson } from '@openlup/platform/catalog';
import type { CatalogSubscriptionPolicyBinding } from '@openlup/platform/subscriptions';

export const formats = ['capsule', 'powder'] as const;
export type Format = typeof formats[number];

export const units = [
  { code: 'supplements:capsule', dimension: 'count', integral: true,
    factor: { canonicalUnit: 'openlup:piece', unscaled: '1', scale: 0 } },
  { code: 'openlup:g', dimension: 'mass', integral: false,
    factor: { canonicalUnit: 'openlup:g', unscaled: '1', scale: 0 } },
] as const;

const dose = {
  capsule: { dimension: 'count', unit: 'openlup:piece', unscaled: '2', scale: 0 },
  powder: { dimension: 'mass', unit: 'openlup:g', unscaled: '5', scale: 0 },
} as const satisfies Record<Format, CatalogQuantity>;

export const scoopMass = dose.powder;
export const cadenceDays = 28;

export const policy = {
  kind: 'units_per_day',
  coverage: 'exact',
  ref: {
    key: 'supplements:daily-use',
    version: 1,
    digest: createHash('sha256').update(canonicalCatalogDraftJson({ coverage: 'exact', scope: 'per_line', dose })).digest('hex'),
  },
} as const satisfies CatalogSubscriptionPolicyBinding;

export function demandFor(format: Format, net: CatalogQuantity) {
  return { contentPerUnit: canonicalizeCatalogQuantity(net, units), perDay: dose[format] };
}

export function checkAge(requiresAdultAttestation: boolean, attestation: boolean | undefined) {
  return requiresAdultAttestation && attestation !== true
    ? { code: 'age_attestation_required', path: '/adultAttestation' } as const
    : undefined;
}

const labelFields = ['ingredients', 'supplementFacts', 'allergens', 'warnings', 'claims', 'evidence'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function validateContent(content: unknown) {
  const document = isRecord(content) && content.document;
  if (!isRecord(document)) return [{ path: 'document', code: 'document_required' }];
  const issues = labelFields.flatMap(field => {
    const values = document[field];
    return Array.isArray(values) && values.length > 0 && values.every(hasText)
      ? [] : [{ path: `document.${field}`, code: `${field}_required` }];
  });
  if (!hasText(document.title)) issues.push({ path: 'document.title', code: 'title_required' });
  const serving = document.serving;
  if (!isRecord(serving) || typeof serving.perContainer !== 'number'
    || !Number.isSafeInteger(serving.perContainer) || serving.perContainer < 1
    || (serving.unit !== 'capsule_pair' && serving.unit !== 'scoop')) {
    issues.push({ path: 'document.serving', code: 'serving_invalid' });
  }
  if (typeof document.adultsOnly !== 'boolean') issues.push({ path: 'document.adultsOnly', code: 'adults_only_required' });
  return issues;
}
