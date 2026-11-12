import type { PromotionRow } from '@openlup/core/promo';
import { AcquisitionTermsError, type AcquisitionFinancialPolicy } from '@openlup/platform/pricing';

/** Standalone configured offers use the package selector; no historical pair is seeded. */
export function createAcquisitionFinancialPolicy(): AcquisitionFinancialPolicy<PromotionRow> {
  type Row = PromotionRow & { promotion_engine_version?: unknown; benefit_lane?: unknown; benefit_kind?: unknown;
    benefit_value_bps?: unknown; benefit_value_minor?: unknown; v2_mirror_of?: unknown };
  const tagged = (row: Row) => Object.hasOwn(row.applies_to_payload, 'acquisitionTerms');
  const target = (row: Row) => row.trigger_type === 'automatic' && row.code === null
    && row.applies_to_kind === 'order_total' && row.stacking_rule === 'exclusive'
    && row.applies_to_payload.cart_mode === 'subscription' && Object.keys(row.eligibility).length === 1
    && row.eligibility.first_subscription_purchase === true && row.promotion_engine_version === 'promotion-engine.v2'
    && row.discount_type === 'percentage' && row.benefit_lane === 'product' && row.benefit_kind === 'target_percentage'
    && typeof row.benefit_value_bps === 'number' && Number.isInteger(row.benefit_value_bps)
    && row.benefit_value_bps > 0 && row.benefit_value_bps < 10000 && row.discount_value === row.benefit_value_bps / 100
    && row.benefit_value_minor == null;
  return {
    facts: (row: Row) => ({ id: row.id, active: row.status === 'active', regionCodes: row.region_availability,
      validFrom: row.valid_from, validTo: row.valid_to, mirrorOf: row.v2_mirror_of,
      metadataPresent: tagged(row), metadata: row.applies_to_payload.acquisitionTerms }),
    classify: (row: Row) => ({ baselineLegacy: false, target: target(row), canonicalRow: tagged(row), unconfiguredLegacyEligible: false }),
    validateMetadata(row: Row) {
      if (!target(row) || Object.keys(row.applies_to_payload).length !== 2 || row.redemption_limit_global != null
        || row.redemption_limit_per_customer !== 1 || row.v2_mirror_of != null) throw new AcquisitionTermsError('acquisition_terms_invalid');
    },
    pairMatches: () => false,
    initialDiscountBps: (row: Row) => row.benefit_value_bps,
    unconfiguredTerms: () => { throw new AcquisitionTermsError('acquisition_terms_invalid'); },
  };
}

/** Neutral demonstration bounds; these values do not establish a real market or phone jurisdiction. */
export const customerAccountPolicy = { key: { min: 8, max: 180 }, name: { min: 2, max: 80 },
  phone: { callingCode: '999', localDigits: 9 }, correction: { reasonMin: 8, reasonMax: 500, fieldsMax: 20, fieldMax: 80, noteMax: 500 } };
export const checkoutLinkPolicy = { operatorLifetimeMs: 86400000, recoveryWindowMs: 2592000000 };
export const checkoutWavePolicy = { profile: 'starter_capture', firstOffsetSeconds: 3600, finalOffsetSeconds: 72000,
  checkoutSeconds: 86400, recoverySeconds: 2592000, activitySeconds: 900 };
export const checkoutRecoverySchedule = { enabled: true, leaseSeconds: 120, batchSize: 100, initialTimeoutSeconds: 7200, softBudgetMs: 15000 };


/** Fictional demonstration address formats, including a numeric checksum mechanism. */
export function savedAddressValidation(country: string) {
  return { country, countryAliases: ['example'], phonePrefix: customerAccountPolicy.phone.callingCode,
    normalizeTaxId: (value: string | null) => (value ?? '').replace(/\D/g, '') || null,
    isValidTaxId: (value: string) => /^\d{10}$/.test(value)
      && [6,5,7,2,3,4,5,6,7].reduce((sum, weight, index) => sum + weight * Number(value[index]), 0) % 11 === Number(value[9]),
    messages: { name: 'Invalid recipient', country: 'Invalid country', phone: 'Invalid phone', postalCode: 'Invalid postal code', taxId: 'Invalid demonstration tax identifier' } };
}

/** Billing/default hints deliberately stay unselected until the billing store is composed. */
export const accountBillingSelection = 'not_selected' as const;


/** Explicit synthetic identities only; no real instrument or provider taxonomy. */
export const sandboxRecoveryPolicy = { cookieName: '__Host-openlup_checkout_continuation', rails: ['sandbox','external'] as const,
  methodKeys: ['primary','secondary'] as const, buyerLifetimeMs: 86400000, buyerSendBucketMs: 600000 };
