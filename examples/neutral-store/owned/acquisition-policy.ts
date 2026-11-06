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
