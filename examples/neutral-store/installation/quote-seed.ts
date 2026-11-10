import { createHash } from 'node:crypto';
import { canonicalCatalogDraftJson } from '@openlup/platform/catalog';
import { digestSubscriptionPricePolicy, ACQUISITION_TERMS_CAPABILITY } from '@openlup/platform/pricing';
import type { StoreConfig } from '../shared/config.ts';
import type { DemonstrationInstallation } from './install.ts';
import { demoIdentifier, type buildDemoSeed } from '../owned/demo-seed.ts';

export const documentDigest = (value: unknown) => createHash('sha256').update(canonicalCatalogDraftJson(value)).digest('hex');

/** Install-only composition on the caller's existing transaction. Never rotates an initialized revision. */
export async function seedQuoteAuthority(config: StoreConfig, seed: ReturnType<typeof buildDemoSeed>, connection: DemonstrationInstallation['connection']) {
  const policy = { id: demoIdentifier(config, 'subscription-policy', String(config.quote.policy.revisionNo)),
    revisionNo: config.quote.policy.revisionNo, priceListId: seed.priceLists[0]!.id,
    regionCode: config.market.country, currency: config.market.currency, channel: config.quote.policy.channel,
    effectiveFrom: new Date(config.quote.policy.effectiveFrom).toISOString(), effectiveTo: null,
    discountBps: config.offer.subscriptionDiscountBps, roundingQuantumMinor: config.offer.subscriptionRoundingQuantumMinor,
    roundingRule: 'FLOOR_TO_QUANTUM' as const };
  const digest = await digestSubscriptionPricePolicy(policy);
  const history = (await connection.query('SELECT id,digest FROM public.subscription_price_policy_revisions WHERE price_list_id=$1 FOR SHARE', [policy.priceListId])).rows;
  if (history.length && (history.length !== 1 || history[0]!.id !== policy.id || history[0]!.digest !== digest)) throw new Error('starter_policy_seed_conflict');
  await connection.query(`INSERT INTO public.subscription_price_policy_revisions
    (id,revision_no,price_list_id,region_code,currency,channel,effective_from,effective_to,discount_bps,rounding_quantum_minor,rounding_rule,digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
  [policy.id,policy.revisionNo,policy.priceListId,policy.regionCode,policy.currency,policy.channel,policy.effectiveFrom,null,
    policy.discountBps,policy.roundingQuantumMinor,policy.roundingRule,digest]);
  const saved = (await connection.query('SELECT digest FROM public.subscription_price_policy_revisions WHERE id=$1 FOR SHARE', [policy.id])).rows;
  if (saved.length !== 1 || saved[0]!.digest !== digest) throw new Error('starter_policy_seed_conflict');
  for (const row of seed.documents) {
    const document = row.document;
    await connection.query(`INSERT INTO public.catalog_product_document_revisions
      (id,product_id,revision_no,schema_id,document_ref,document_payload,provenance,source_ref,digest)
      VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8) ON CONFLICT (id) DO NOTHING`,
    [row.id,row.productId,document.revisionNo,document.schemaVersion,
      `demo-document:${config.id}:${row.id}`,document,document.sourceRef,row.digest]);
    const existing = (await connection.query('SELECT digest FROM public.catalog_product_document_revisions WHERE id=$1 FOR SHARE', [row.id])).rows;
    if (existing.length !== 1 || existing[0]!.digest !== row.digest) throw new Error('starter_document_seed_conflict');
    const primary = document.variants[0]!;
    const facts = (await connection.query(`SELECT p.primary_sku_id,p.current_document_revision_id,s.net_weight_g
      FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id WHERE p.id=$1 AND s.id=$2`, [row.productId,primary.skuId])).rows[0];
    if (!facts || (facts.primary_sku_id !== null && facts.primary_sku_id !== primary.skuId)
      || (facts.current_document_revision_id !== null && facts.current_document_revision_id !== row.id)
      || (facts.current_document_revision_id !== null && facts.net_weight_g !== primary.physical.netWeightG)) throw new Error('starter_document_seed_conflict');
    await connection.query('UPDATE public.catalog_products SET primary_sku_id=$2,current_document_revision_id=$3 WHERE id=$1', [row.productId,primary.skuId,row.id]);
    for (const variant of document.variants) {
      await connection.query('UPDATE public.catalog_skus SET net_weight_g=$2 WHERE id=$1', [variant.skuId,variant.physical.netWeightG]);
      await connection.query(`INSERT INTO public.catalog_sku_identifiers
        (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary)
        VALUES($1,$2,'gtin',$3,'unit',1,true) ON CONFLICT DO NOTHING`, [variant.skuId,variant.physical.issuer,variant.physical.unitGtin]);
    }
  }
  const offer = config.quote.acquisition;
  const promotionId = `demo-acquisition:${config.id}`;
  const definition = { id: promotionId, status: offer.enabled ? 'active' : 'paused', name: offer.label, code: null,
    trigger_type: 'automatic', discount_type: 'percentage', discount_value: offer.initialDiscountBps / 100,
    applies_to_kind: 'order_total', applies_to_payload: { cart_mode: 'subscription', acquisitionTerms: {
      schemaVersion: ACQUISITION_TERMS_CAPABILITY, revision: offer.revision, delivery2DiscountBps: offer.delivery2DiscountBps } },
    stacking_rule: 'exclusive', eligibility: { first_subscription_purchase: true }, region_availability: [config.market.country],
    valid_from: offer.effectiveFrom, valid_to: offer.effectiveTo, redemption_limit_global: null, redemption_limit_per_customer: 1,
    promotion_engine_version: 'promotion-engine.v2', benefit_lane: 'product', benefit_kind: 'target_percentage',
    benefit_value_bps: offer.initialDiscountBps, benefit_value_minor: null, v2_mirror_of: null };
  await connection.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active)
    VALUES($1,$2,$3) ON CONFLICT (promotion_id) DO NOTHING`, [promotionId,definition,offer.enabled]);
  const current = (await connection.query('SELECT definition,active FROM public.commerce_promotion_definitions WHERE promotion_id=$1 FOR SHARE', [promotionId])).rows;
  if (current.length !== 1 || current[0]!.active !== offer.enabled
    || canonicalCatalogDraftJson(current[0]!.definition) !== canonicalCatalogDraftJson(definition)) throw new Error('starter_promotion_seed_conflict');
}
