import type { CatalogQuantity } from '@openlup/core/catalog';
import { starterDiagnostic } from './refusals.ts';

export type SeedPhysical = {
  netContent: CatalogQuantity;
  primaryUnitIdentifier: { scheme: string; issuer: string; value: string } | null;
};

const recheck = 'Restart the starter and recheck `/api/config`.';
export const seedPhysicalGuidance = {
  OPENLUP_E_STARTER_PRODUCT_PHYSICAL_INVALID: {
    path: 'offer.products[].physical',
    observed: 'The configured product physical facts were refused.',
    cause: 'Seed products require positive whole grams in the signed 32-bit range, a valid primary gs1:gtin and an unchanged issuer.',
    fix: 'Apply the owned configuration migration where needed and correct the entry from verified facts. If correcting the issuer changes the retained seed digest, use “Reset an interrupted first install” for an owner-approved rebuild of the disposable demonstration in the same Compose project. That procedure removes all data in the demo volume.',
    recheck,
  },
  OPENLUP_E_STARTER_SYNTHETIC_PHYSICAL_SIZE_INVALID: {
    path: 'subscriptionEditing.catalogue[].physicalSize',
    observed: 'The configured editor catalogue size was refused.',
    cause: 'The size must be a number of whole grams from 1 through 2147483647.',
    fix: 'Correct the affected `physicalSize` in `owned/subscription-editing.ts` to the verified supported whole-gram size.',
    recheck,
  },
};

export function seedPhysicalError(code: keyof typeof seedPhysicalGuidance, sku: string) {
  const { path, fix } = seedPhysicalGuidance[code];
  const subject = typeof sku === 'string' && sku.length ? sku : '(invalid SKU)';
  const guidance = { path, fix, subject };
  return starterDiagnostic(code, undefined, guidance);
}

export function isSeedGramSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function hasFields(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Admit owned facts and copy them into the predecessor document shape. */
export function configuredSeedPhysical(physical: SeedPhysical, sku: string, isValidGtin: (value: string) => boolean) {
  const invalid = () => seedPhysicalError('OPENLUP_E_STARTER_PRODUCT_PHYSICAL_INVALID', sku);
  if (!hasFields(physical, ['netContent', 'primaryUnitIdentifier'])) throw invalid();
  const { netContent, primaryUnitIdentifier } = physical;
  if (!hasFields(netContent, ['dimension', 'unit', 'unscaled', 'scale']) || !primaryUnitIdentifier
    || !hasFields(primaryUnitIdentifier, ['scheme', 'issuer', 'value'])) throw invalid();
  const { dimension, unit, unscaled, scale } = netContent;
  const { scheme, issuer, value } = primaryUnitIdentifier;
  const grams = typeof unscaled === 'string' && /^[1-9][0-9]{0,9}$/u.test(unscaled) ? Number(unscaled) : NaN;
  if (dimension !== 'mass' || unit !== 'openlup:g' || scale !== 0 || !isSeedGramSize(grams)
    || scheme !== 'gs1:gtin' || typeof value !== 'string' || !isValidGtin(value)
    || typeof issuer !== 'string' || issuer.length < 1 || issuer.length > 240
    || issuer !== issuer.trim() || issuer.includes('\0') || /[\uD800-\uDFFF]/u.test(issuer)) throw invalid();
  return { netWeightG: grams, unitGtin: value, issuer };
}
