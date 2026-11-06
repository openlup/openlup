import { createPostgresCommerceQuoteCatalogReadPort,
  type NeutralSkuEnvelopeV1 } from '@openlup/platform/catalog';
import { createCommercePriceAuthorityPort, createDbBackedCommerceQuotePort, CommerceQuoteCatalogReadError,
  type CommercePriceAuthorityReadPort, type CreateQuoteRequest, type CommerceQuoteCatalogItem } from '@openlup/platform/pricing';
import { createPostgresStockAvailability } from '@openlup/platform/inventory';
import type { CompositionRulesPort } from '@openlup/core/bundle';
import type { SizedCatalogFact, SizedHostPorts, SubscriptionQueryExecutor, PackageEditConstraintMapper } from '@openlup/platform/subscriptions';
import type { StoreConfig } from '../shared/config.ts';
import { isRecord } from '../shared/offer.ts';
import { documentDigest, editorProducts, demoIdentifier } from './editor-catalogue.ts';

const instant = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
type Document = { schema: string; productId: string; variants: { id: string; sku: string; physicalSize: number; demandPerUnit: number; exclusions: string[] }[] };
function document(value: unknown): Document {
  if (!isRecord(value) || value.schema !== 'starter:subscription-item@1' || typeof value.productId !== 'string'
    || !Array.isArray(value.variants) || !value.variants.length || value.variants.some(row => !isRecord(row)
      || typeof row.id !== 'string' || typeof row.sku !== 'string' || !Number.isSafeInteger(row.physicalSize) || Number(row.physicalSize) <= 0
      || !Number.isSafeInteger(row.demandPerUnit) || Number(row.demandPerUnit) <= 0
      || !Array.isArray(row.exclusions) || row.exclusions.some(key => typeof key !== 'string' || !key))) {
    throw new Error('subscription_reprice_sized_catalog_facts_unreadable');
  }
  return value as Document;
}
function verifyDocument(value: unknown, envelope: NeutralSkuEnvelopeV1): Promise<void> {
  const parsed = document(value), variants = parsed.variants.filter(row => row.id === envelope.sku.id && row.sku === envelope.sku.code);
  if (parsed.productId !== envelope.product.id || variants.length !== 1 || variants[0]!.physicalSize !== envelope.sku.netContent.unscaled
    || envelope.documentRevision.schemaId !== parsed.schema || documentDigest(value) !== envelope.documentRevision.digest) {
    throw new CommerceQuoteCatalogReadError('catalog_revision_invalid');
  }
  return Promise.resolve();
}
/** Exact effective-list selection and amount policy stay in the public pricing authority. */
function priceReads(db: SubscriptionQueryExecutor): CommercePriceAuthorityReadPort {
  const entries = async (variantId: string, priceListId: string, mode: 'one_time' | 'subscription') =>
    (await db.query(`SELECT * FROM public.price_entries WHERE variant_id=$1::uuid AND price_list_id=$2::uuid
      AND mode=$3 AND min_qty=1 AND active`, [variantId,priceListId,mode])).rows.map(row => ({
      validFrom: instant(row.valid_from), validTo: row.valid_to == null ? null : instant(row.valid_to),
      value: { variantId: String(row.variant_id), mode, matchedMinQty: Number(row.min_qty), unitPriceMinor: Number(row.unit_price_minor),
        amountKind: row.amount_kind === 'gross' ? 'gross' as const : 'net' as const, priceListId: String(row.price_list_id), priceEntryId: String(row.id), resolvedAt: '' } }));
  return {
    async listPriceLists({ regionCode,currency }) { return (await db.query(`SELECT * FROM public.price_lists WHERE region_code=$1 AND currency=$2 AND status='active'`,
      [regionCode,currency])).rows.map(row => ({ value: String(row.id),validFrom: instant(row.valid_from),validTo: row.valid_to == null ? null : instant(row.valid_to) })); },
    listExactBaseEntries: ({ variantId,priceListId }) => entries(variantId,priceListId,'one_time'),
    listExactLegacySubscriptionEntries: ({ variantId,priceListId }) => entries(variantId,priceListId,'subscription'),
    async listSubscriptionPolicyHistory({ priceListId,regionCode,currency,channel }) {
      return (await db.query(`SELECT * FROM public.subscription_price_policy_revisions WHERE price_list_id=$1::uuid AND region_code=$2 AND currency=$3 AND channel=$4`,
        [priceListId,regionCode,currency,channel])).rows.map(row => ({ validFrom: instant(row.effective_from),validTo: row.effective_to == null ? null : instant(row.effective_to),
        value: { id: row.id,priceListId: row.price_list_id,regionCode: row.region_code,currency: row.currency,channel: row.channel,
          revisionNo: row.revision_no,discountBps: row.discount_bps,roundingQuantumMinor: row.rounding_quantum_minor,roundingRule: row.rounding_rule,
          effectiveFrom: instant(row.effective_from),effectiveTo: row.effective_to == null ? null : instant(row.effective_to),digest: row.digest } }));
    },
  };
}
export function editorQuotePorts(db: SubscriptionQueryExecutor, config: StoreConfig) {
  const quoteCatalogReadPort = createPostgresCommerceQuoteCatalogReadPort(db, { verifyDocument });
  const taxProfile = { included: true as const,country: config.market.country,category: config.purchase.tax.category,
    vatRateBps: config.purchase.tax.vatRateBps,legalBasis: config.purchase.tax.legalBasis };
  const quotePort = createDbBackedCommerceQuotePort<CreateQuoteRequest,CommerceQuoteCatalogItem,Record<string, never>,{ mode: 'one_time' | 'subscription'; promoCodes: string[]; cadenceDays: number | null }>({
    quoteCatalogReadPort,isStrictD1Quote: true,commercePriceAuthorityPort: createCommercePriceAuthorityPort(priceReads(db)),
    regionCode: config.market.country,currency: config.market.currency,taxProfile,supportedTaxProfiles: [taxProfile],hasPromotionCodePort: false,
    lineContext: () => ({}),quoteContext: request => () => ({ mode: request.mode,promoCodes: [],cadenceDays: request.cadenceDays ?? null }),
    resolveAutomaticQuotePromotions: async () => ({ discounts: [],codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [],codeRejections: [],codeRejectionDetails: [] }),
  });
  const constraintMapper: PackageEditConstraintMapper = {
    toCore: stored => ({ kind: 'starter:composition',version: 1,data: stored ?? {} }),
    fromCore: constraint => constraint.data,
    nominalPlanDays: stored => stored?.kind === 'plan_days' && Number.isSafeInteger(stored.value) ? Number(stored.value) : null,
  };
  const compositionRulesPort: CompositionRulesPort = {
    async validateComposition({ coreLines }) {
      const catalogue = await quoteCatalogReadPort.listQuoteCatalogItems();
      if (!coreLines.length || coreLines.some(line => !Number.isSafeInteger(line.qty) || line.qty < 1
        || !catalogue.some(item => item.variantId === line.variantId && !item.isAddon && item.sellability.subscription))) return { ok: false,code: 'subscription_reprice_non_base_variant' };
      return new Set(coreLines.map(line => line.variantId)).size !== coreLines.length
        ? { ok: false,code: 'subscription_reprice_duplicate_variant' } : { ok: true };
    },
    async resizeComposition({ coreLines,constraint,lever }) {
      if (lever.kind !== 'planLengthConstraint' || constraint.data.kind !== 'plan_days') return null;
      return { coreLines,constraint: { ...constraint,data: { ...constraint.data,value: lever.value } } };
    },
  };
  return { quoteCatalogReadPort,quotePort,constraintMapper,compositionRulesPort };
}

/** A seeded synthetic profile is shared by this demonstration's owned customer subjects.
 * Locking its installed row protects fact equality through the package's apply transaction. */
export function sizedHostPorts(config: StoreConfig, now: () => string): Omit<SizedHostPorts, 'quotePort'> {
  const read = async (db: SubscriptionQueryExecutor, context: { subscriptionId: string; clientId: string }, lock = false) => {
    const row = (await db.query(`SELECT settings.value_text FROM public.commerce_settings settings
      WHERE settings.key=$1 AND EXISTS(SELECT 1 FROM public.subscriptions s JOIN public.clients c ON c.id=s.client_id
      WHERE s.id=$2::uuid AND s.client_id=$3::uuid) ${lock ? 'FOR UPDATE OF settings' : ''}`,
    [`starter_sized_subject:${config.id}`,context.subscriptionId,context.clientId])).rows[0];
    let value: unknown;
    try { value = JSON.parse(String(row?.value_text)); } catch { throw new Error('subscription_reprice_sized_subject_facts_unreadable'); }
    if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || !Number.isSafeInteger(value.dailyNeed) || Number(value.dailyNeed) < 1) throw new Error('subscription_reprice_sized_subject_facts_unreadable');
    const exclusions = Object.hasOwn(value,'currentExclusions') ? value.currentExclusions : value.inheritedExclusions;
    if (!Array.isArray(exclusions) || exclusions.some(key => typeof key !== 'string' || !key)) throw new Error('subscription_reprice_sized_subject_facts_unreadable');
    return { value,exclusions: exclusions as string[],dailyNeed: Number(value.dailyNeed) };
  };
  return {
    async readFacts(db,context) { const facts = await read(db,context);
      return { subscriptionId: context.subscriptionId,clientId: context.clientId,subjectRef: `starter:${context.clientId}`,exclusions: facts.exclusions,snapshot: facts.value }; },
    async resolveOptInNeed(db,context) { const facts = await read(db,context); return { dailyNeed: facts.dailyNeed,snapshot: facts.value }; },
    async assertCurrentFacts(db,context,expected,need) { const facts = await read(db,context,true);
      if (documentDigest(facts.value) !== documentDigest(expected.snapshot) || need !== null && documentDigest(need) !== documentDigest(facts.value)) throw new Error('subscription_edit_invalid_subject_snapshot'); },
    async readCatalog(db) {
      const products = editorProducts(config);
      const rows = (await db.query(`SELECT sku.id,sku.sku,sku.product_id,sku.is_addon,sku.status,sku.sellable_in_subscription,sku.net_weight_g,product.status AS product_status,
        product.current_document_revision_id,revision.document_payload,revision.digest FROM public.catalog_skus sku
        JOIN public.catalog_products product ON product.id=sku.product_id
        JOIN public.catalog_product_document_revisions revision ON revision.id=product.current_document_revision_id
        WHERE sku.id=ANY($1::uuid[]) ORDER BY sku.id`, [products.map(product => demoIdentifier(config,'sku',product.sku))])).rows;
      const stock = await createPostgresStockAvailability(db, { sourceKey: `starter-demo:${config.id}`,now }).readPort.read({
        skus: rows.map(row => String(row.sku)),horizonDays: 14,excludeOrderId: null });
      return rows.map((row): SizedCatalogFact => {
        const parsed = document(row.document_payload), variant = parsed.variants.find(item => item.id === row.id && item.sku === row.sku);
        if (!variant || parsed.productId !== row.product_id || variant.physicalSize !== row.net_weight_g || documentDigest(parsed) !== row.digest) throw new Error('subscription_reprice_sized_catalog_facts_unreadable');
        const availability = stock.get(String(row.sku));
        return { variantId: String(row.id),sku: String(row.sku),groupId: String(row.product_id),isAddon: row.is_addon === true,
          sellable: row.status === 'active' && row.product_status === 'active' && row.sellable_in_subscription === true,physicalSize: variant.physicalSize,demandPerUnit: variant.demandPerUnit,
          documentRevisionId: String(row.current_document_revision_id),documentDigest: String(row.digest),verified: true,exclusions: variant.exclusions,
          sellableNow: availability?.stale ? 0 : availability?.availableForNewPurchases ?? null };
      });
    },
    // The demonstration intentionally supplies no demand-driven resize policy.
    proposePortion: async () => { throw new Error('starter_subscription_resize_unconfigured'); },
  };
}
