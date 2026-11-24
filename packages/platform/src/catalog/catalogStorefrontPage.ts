import type { ResolvedPrice } from "@openlup/core/pricing";
import type { PgQueryExecutor, PostgresRoleFreeTransactionLane } from "../data/index.js";
import {
  CommercePriceAuthorityError, createCommercePriceAuthorityPort, type CommercePriceAuthorityPort, type CommercePriceAuthorityQuery,
  type CommercePriceAuthorityReadPort, type CommercePriceAuthorityRefusal, type TimedAuthorityValue,
} from "../pricing/index.js";
import type { CatalogAttributeValue } from "./contracts/draftV2.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { AttributeDefinition } from "./contracts/attributes.js";
import { isValidGtin } from "./contracts/foundation.js";
import type { CatalogOptionValue, CatalogProductTypeDefinition, CatalogQuantity } from "./contracts/productTypes.js";
import { catalogPriceContextSchema } from "./foundationSchemas.js";
import { isInternalGtin14 } from "./internalGtin.js";
import { readPostgresCatalogMembershipPage, type CatalogDiscoveryRefusal, type CatalogMembershipCursor,
  type CatalogMembershipItem } from "./postgresPublicationDiscovery.js";
import { catalogPublishedProductSchema, catalogPublishedSkuSchema } from "./publicationCodec.js";
import type { CatalogSkuRevisionRef } from "./publicationContracts.js";
import { publicationReadFailure } from "./publicationError.js";
import { z } from "./validation.js";

/** @experimental */
export interface CatalogStorefrontPageInput {
  offerVersion: string;
  regionCode: string;
  currency: string;
  channel: string;
  limit: number;
  cursor?: CatalogMembershipCursor | null;
}

/** @experimental */
export interface CatalogStorefrontPrice {
  amountMinor: number;
  currency: string;
  amountBasis: "tax_inclusive" | "tax_exclusive";
}

/** @experimental */
export interface CatalogStorefrontSku {
  skuId: string;
  skuCode: string;
  skuRevision: CatalogSkuRevisionRef;
  title: string;
  minQuantity: number;
  options: Readonly<Record<string, CatalogOptionValue>>;
  attributes: Readonly<Record<string, CatalogAttributeValue>>;
  netContent: CatalogQuantity;
  primaryUnitIdentifier: { scheme: string; issuer: string; value: string } | null;
  sell: { oneTime: boolean; subscription: boolean };
  price: {
    oneTime: CatalogStorefrontPrice | null;
    subscription: CatalogStorefrontPrice | null;
  };
}

/** @experimental */
export interface CatalogStorefrontProduct {
  productId: string;
  slug: string;
  name: string;
  typeRef: { key: string; version: number };
  definitionDigest: string | null;
  attributes: Readonly<Record<string, CatalogAttributeValue>>;
  presentation: CatalogPublicationFacts | null;
  skus: CatalogStorefrontSku[];
}

/** @experimental */
export type CatalogStorefrontPageResult =
  | { protocol: "legacy"; products: []; nextCursor: null }
  | {
    protocol: "governed";
    headDigest: string;
    products: CatalogStorefrontProduct[];
    nextCursor: CatalogMembershipCursor | null;
  }
  | (CatalogDiscoveryRefusal & { message: string; issue?: "offer_unpublished" });

type PublishedSku = Pick<CatalogStorefrontSku, "skuCode" | "title" | "minQuantity" | "netContent" | "sell" | "price" | "attributes"> & {
  primaryUnitIdentifier: (NonNullable<CatalogStorefrontSku["primaryUnitIdentifier"]> & { internal: boolean }) | null;
};
type PublishedProduct = Pick<CatalogStorefrontProduct, "slug" | "name" | "presentation" | "attributes"> & { skus: PublishedSku[] };

/** A filtered public offer with its server-side continuation.
 * @experimental
 */
export type PublishedCatalogOfferPage =
  | { protocol: "legacy"; products: []; nextCursor: null }
  | { protocol: "governed"; products: PublishedProduct[]; nextCursor: CatalogMembershipCursor | null };

type InstalledDefinition = { type: Pick<CatalogProductTypeDefinition, "key" | "version" | "attributes">; digest: string };

function verifiedAttributes(receipts: readonly InstalledDefinition[], seal: string | null): readonly AttributeDefinition[] {
  const first = receipts[0];
  if (!first || !/^[0-9a-f]{64}$/u.test(first.digest) || receipts.some(row => row.digest !== first.digest)) return [];
  try {
    const definitions = first.type.attributes ?? [];
    const bytes = canonicalCatalogDraftJson(definitions);
    if (receipts.some(row => canonicalCatalogDraftJson(row.type.attributes ?? []) !== bytes)) return [];
    return seal === null || seal === first.digest ? definitions : [];
  } catch { return []; }
}

function publicAttributes(values: CatalogStorefrontProduct["attributes"], definitions: readonly AttributeDefinition[], scope: AttributeDefinition["scope"]) {
  return Object.fromEntries(definitions.filter(row => row.scope === scope && row.public === true && Object.hasOwn(values, row.key))
    .map(({ key }) => [key, structuredClone(values[key])]));
}

function publicPrice(price: CatalogStorefrontPrice | null): CatalogStorefrontPrice | null {
  if (!price) return null;
  const { amountMinor, currency, amountBasis } = price;
  return { amountMinor, currency, amountBasis };
}

/** Projects receipt-verified attributes and authored public presentation for outward use.
 * @experimental
 */
export function projectPublishedCatalogOfferPage(page: Extract<CatalogStorefrontPageResult, { protocol: string }>,
  installedDefinitions: readonly InstalledDefinition[]): PublishedCatalogOfferPage {
  if (page.protocol === "legacy") return { protocol: "legacy", products: [], nextCursor: null };
  const products = page.products.map(product => {
    const { slug, name, presentation, typeRef, definitionDigest, attributes, skus } = product;
    const receipts = installedDefinitions.filter(row => row.type.key === typeRef.key && row.type.version === typeRef.version);
    const definitions = verifiedAttributes(receipts, definitionDigest);
    return { slug, name, presentation: structuredClone(presentation), attributes: publicAttributes(attributes, definitions, "product"),
      skus: skus.map(({ skuCode, title, minQuantity, netContent, primaryUnitIdentifier, sell, price, attributes }): PublishedSku => {
        const identifier = primaryUnitIdentifier;
        const { dimension, unit, unscaled, scale } = netContent;
        return { skuCode, title, minQuantity, netContent: { dimension, unit, unscaled, scale },
          sell: { oneTime: sell.oneTime, subscription: sell.subscription },
          price: { oneTime: publicPrice(price.oneTime), subscription: publicPrice(price.subscription) },
          attributes: publicAttributes(attributes, definitions, "variant"),
          primaryUnitIdentifier: identifier && { scheme: identifier.scheme, issuer: identifier.issuer, value: identifier.value,
            internal: identifier.scheme !== "gs1:gtin" || !isValidGtin(identifier.value) || isInternalGtin14(identifier.value.padStart(14, "0")) },
        };
      }),
    };
  });
  return { protocol: "governed", products, nextCursor: page.nextCursor && { ...page.nextCursor } };
}

const offerVersion = z.string().min(1).max(240)
  .refine(value => value.trim() === value && !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value));
const storefrontInput = catalogPriceContextSchema.pick({ regionCode: true, currency: true }).extend({
  channel: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u),
  offerVersion,
  limit: z.number().int().min(1).max(100),
  cursor: z.strictObject({
    skuId: z.guid().refine(value => value === value.toLowerCase()),
    headDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    offerVersion,
    mode: z.null(),
  }).nullish(),
}).refine(input => !input.cursor || input.cursor.offerVersion === input.offerVersion);

function isPlainObject(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotInput(input: CatalogStorefrontPageInput) {
  try {
    if (!isPlainObject(input)) return null;
    const copy = { ...input };
    const cursor = copy.cursor;
    if (cursor != null && !isPlainObject(cursor)) return null;
    const parsed = storefrontInput.safeParse({ ...copy, cursor: cursor == null ? cursor : { ...cursor } });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Refusal = Extract<CatalogStorefrontPageResult, { outcome: string }>;
const unpublished = z.strictObject({ kind: z.literal("refusal"), reason: z.literal("unknown_offer") });

const fixes = {
  catalog_offer_memberships_page_input_invalid: "Use a published offer version and valid region, currency, channel and page size. Start without a cursor, then reuse the cursor returned for that offer.",
  catalog_publication_head_moved: "Read again from the first page.",
  catalog_publication_transaction_conflict: "Retry the page in a new transaction after the concurrent operation finishes.",
  catalog_publication_read_busy: "Retry the page in a new transaction after the concurrent operation finishes.",
  catalog_publication_read_not_authorized: "Configure the storefront connection to use the installed platform runtime login, then read again.",
  catalog_publication_live_drift: "Prepare a compensation revision against the current head, approve it with a fresh key, and publish it.",
  catalog_publication_read_unavailable: "Retry the read. If the publication evidence is damaged, restore the catalogue from a verified backup containing the published revision.",
  active_price_list_ambiguous: "End the overlapping price lists so exactly one is effective for the requested region and currency.",
  base_price_ambiguous: "End the overlapping entries so exactly one price with a minimum quantity of one is effective for this SKU and mode.",
  legacy_subscription_price_ambiguous: "End the overlapping entries so exactly one price with a minimum quantity of one is effective for this SKU and mode.",
  subscription_price_policy_ambiguous: "Resolve the overlapping policy revisions so exactly one verified revision is effective for this price list, region, currency and channel.",
  base_price_amount_kind_invalid: "Set a positive gross one-time base price within the supported range. If the subscription amount is invalid, correct its effective price entry or policy.",
  price_shape_invalid: "Set a positive gross one-time base price within the supported range. If the subscription amount is invalid, correct its effective price entry or policy.",
  subscription_price_policy_invalid: "Restore the original verified policy revision for this price context. If pricing terms must change, install a valid successor revision.",
  subscription_price_policy_digest_mismatch: "Restore the original verified policy revision for this price context. If pricing terms must change, install a valid successor revision.",
  subscription_price_policy_original_tuple_unverified: "Restore the original verified policy revision for this price context. If pricing terms must change, install a valid successor revision.",
  publication_authority_unavailable: "Check the PostgreSQL connection and TLS settings, verify the runtime login and its installed grants, and finish applying the platform migrations. Then read again.",
} as const;

const missingPrice = new Set<CommercePriceAuthorityRefusal>([
  "active_price_list_not_found", "base_price_not_found", "legacy_subscription_price_not_found", "subscription_price_policy_not_effective",
]);

function withFix(refusal: Omit<Refusal, "message">): Refusal {
  if (Object.hasOwn(fixes, refusal.reason)) return { ...refusal, message: fixes[refusal.reason as keyof typeof fixes] };
  return unavailable("catalog_publication_read_unavailable");
}

function unavailable(reason: keyof typeof fixes): Refusal {
  return { outcome: "dependency_unavailable", reason, message: fixes[reason] };
}

const invalidAmount = Symbol("price_shape_invalid");

function failure(error: unknown): Refusal {
  if (error === invalidAmount) return unavailable("price_shape_invalid");
  if (error instanceof CommercePriceAuthorityError) return withFix({ outcome: "dependency_unavailable", reason: error.code });
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "40001" || code === "40P01" || code === "55P03") {
    return withFix({ outcome: "conflict", retryable: true,
      reason: code === "55P03" ? "catalog_publication_read_busy" : "catalog_publication_transaction_conflict" });
  }
  const classified = publicationReadFailure(error);
  const reason = Object.hasOwn(fixes, classified.reason) ? classified.reason : "publication_authority_unavailable";
  return Object.defineProperty({ outcome: "dependency_unavailable", reason, message: fixes.publication_authority_unavailable },
    "cause", { value: error });
}

// Membership already compared publication_facts with the sealed product and SKU. In the same
// snapshot, cross-check the additional serving columns before projecting those certified facts.
const projectionSql = `SELECT s.id AS "skuId", p.publication_facts AS product, s.publication_facts AS sku
  FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
  WHERE s.id=ANY($1::uuid[])
    AND (to_jsonb(s.title),to_jsonb(s.min_order_qty),s.option_values,s.attribute_values)
      IS NOT DISTINCT FROM (s.publication_facts->'title',s.publication_facts->'minQuantity',
        s.publication_facts->'options',s.publication_facts->'attributes')
    AND (to_jsonb(p.name),jsonb_build_object('key',p.type_key,'version',p.type_version),p.attribute_values)
      IS NOT DISTINCT FROM (p.publication_facts->'name',p.publication_facts->'type',p.publication_facts->'attributes')`;

function gramsToNetContent(grams: number): CatalogQuantity {
  return { dimension: "mass", unit: "openlup:g", scale: 0, unscaled: String(grams) };
}

async function readProjection(db: PgQueryExecutor, items: CatalogMembershipItem[]) {
  if (items.length === 0) return [];
  const { rows } = await db.query(projectionSql, [items.map(item => item.skuId)]);
  if (rows.length !== items.length) return unavailable("catalog_publication_live_drift");

  const bySku = new Map(rows.map(row => [row.skuId, row]));
  const products = new Map<string, CatalogStorefrontProduct>();
  for (const item of items) {
    const row = bySku.get(item.skuId);
    if (!row) return unavailable("catalog_publication_live_drift");
    const product = catalogPublishedProductSchema.safeParse(row.product);
    const sku = catalogPublishedSkuSchema.safeParse(row.sku);
    if (!product.success || !sku.success) return unavailable("catalog_publication_read_unavailable");
    if (product.data.id !== item.productId || product.data.slug !== item.productSlug || sku.data.id !== item.skuId
      || sku.data.code !== item.skuCode || sku.data.productId !== item.productId) return unavailable("catalog_publication_live_drift");

    let group = products.get(item.productId);
    if (!group) {
      group = { productId: item.productId, slug: item.productSlug, name: product.data.name,
        typeRef: product.data.type, definitionDigest: product.data.definitionDigest ?? null,
        attributes: product.data.attributes, presentation: item.presentation, skus: [] };
      products.set(item.productId, group);
    }
    const primary = sku.data.identifiers.find(value => value.scheme === "gs1:gtin" && value.packagingLevel === "unit" && value.isPrimary);
    group.skus.push({
      skuId: item.skuId, skuCode: item.skuCode, skuRevision: item.skuRevision, title: sku.data.title,
      minQuantity: sku.data.minQuantity, options: sku.data.options, attributes: sku.data.attributes,
      netContent: gramsToNetContent(item.netWeightG),
      primaryUnitIdentifier: primary ? { scheme: primary.scheme, issuer: primary.issuer, value: primary.value } : null,
      sell: { oneTime: item.sellableStandalone, subscription: item.sellableInSubscription },
      price: { oneTime: null, subscription: null },
    });
  }
  return [...products.values()];
}

function windowTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  // pg returns numeric infinities, which the authority excludes from effective windows.
  if (value === Infinity || value === -Infinity) return String(value);
  throw new Error("Invalid PostgreSQL timestamp");
}

// This adapter is scoped to the page's one price context and set of SKU IDs.
// The authority selects the same effective list for every call, using one atTime.
function storefrontPriceReads(db: PgQueryExecutor, context: Pick<CommercePriceAuthorityQuery, "regionCode" | "currency" | "channel">,
  skus: CatalogStorefrontSku[]): CommercePriceAuthorityReadPort {
  type Entries = Map<string, TimedAuthorityValue<ResolvedPrice>[]>;
  let lists: ReturnType<CommercePriceAuthorityReadPort["listPriceLists"]> | undefined;
  let base: Promise<Entries> | undefined;
  let legacy: Promise<Entries> | undefined;
  let policy: ReturnType<CommercePriceAuthorityReadPort["listSubscriptionPolicyHistory"]> | undefined;

  async function entries(priceListId: string, mode: CommercePriceAuthorityQuery["mode"]): Promise<Entries> {
    const ids = skus.filter(sku => mode === "one_time" || sku.sell.subscription).map(sku => sku.skuId);
    const { rows } = await db.query(`SELECT id,variant_id,unit_price_minor,amount_kind,valid_from,valid_to
      FROM public.price_entries
      WHERE price_list_id=$1 AND variant_id=ANY($2::uuid[]) AND mode=$3 AND min_qty=1 AND active=true
      ORDER BY id`, [priceListId, ids, mode]);
    const bySku: Entries = new Map();
    for (const row of rows) {
      const variantId = row.variant_id as string;
      const validFrom = windowTime(row.valid_from);
      const group = bySku.get(variantId) ?? [];
      group.push({
        value: { priceEntryId: row.id as string, variantId, priceListId, mode, matchedMinQty: 1,
          unitPriceMinor: row.unit_price_minor as number, amountKind: row.amount_kind as ResolvedPrice["amountKind"], resolvedAt: validFrom },
        validFrom, validTo: row.valid_to === null ? null : windowTime(row.valid_to),
      });
      bySku.set(variantId, group);
    }
    return bySku;
  }

  return {
    listPriceLists: () => lists ??= db.query(`SELECT id,valid_from,valid_to FROM public.price_lists
      WHERE region_code=$1 AND currency=$2 AND status='active' ORDER BY id`, [context.regionCode, context.currency])
      .then(({ rows }) => rows.map(row => ({ value: row.id as string, validFrom: windowTime(row.valid_from),
        validTo: row.valid_to === null ? null : windowTime(row.valid_to) }))),
    listExactBaseEntries: async ({ priceListId, variantId }) =>
      (await (base ??= entries(priceListId, "one_time"))).get(variantId) ?? [],
    listExactLegacySubscriptionEntries: async ({ priceListId, variantId }) =>
      (await (legacy ??= entries(priceListId, "subscription"))).get(variantId) ?? [],
    listSubscriptionPolicyHistory: ({ priceListId }) => policy ??= db.query(`SELECT id,digest,closed_from_open,effective_from,effective_to,
      revision_no AS "revisionNo",discount_bps AS "discountBps",rounding_quantum_minor AS "roundingQuantumMinor",
      rounding_rule AS "roundingRule", to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",
      to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveTo"
      FROM public.subscription_price_policy_revisions
      WHERE price_list_id=$1 AND region_code=$2 AND currency=$3 AND channel=$4 ORDER BY revision_no,id`,
    [priceListId, context.regionCode, context.currency, context.channel]).then(({ rows }) =>
      rows.map(({ closed_from_open, effective_from, effective_to, ...row }) => {
        // Window selection uses the driver values. The sealed tuple uses the SQL UTC rendering.
        return { value: { ...row, ...context, priceListId, ...(closed_from_open ? { closedFromOpen: true } : {}) },
          validFrom: windowTime(effective_from), validTo: effective_to === null ? null : windowTime(effective_to) };
      })),
  };
}

function validAmount(amount: number): boolean {
  return Number.isInteger(amount) && amount >= 1 && amount <= 2_147_483_647;
}

async function readPrice(authority: CommercePriceAuthorityPort, query: CommercePriceAuthorityQuery): Promise<CatalogStorefrontPrice | null> {
  try {
    const resolved = await authority.resolvePrice(query);
    const amountMinor = resolved.unitPriceMinor;
    const kind = resolved.kind === "subscription_legacy" ? resolved.legacyResolved.amountKind : resolved.base.amountKind;
    if (!validAmount(resolved.base.unitPriceMinor) || !validAmount(amountMinor) || (kind !== "gross" && kind !== "net")) throw invalidAmount;
    return { amountMinor, currency: query.currency, amountBasis: kind === "gross" ? "tax_inclusive" : "tax_exclusive" };
  } catch (error) {
    if (error instanceof CommercePriceAuthorityError && missingPrice.has(error.code)) return null;
    throw error;
  }
}

/** Reads published catalogue display data and current prices in one snapshot. Checkout resolves its own prices.
 * Use projectPublishedCatalogOfferPage before sending offer rows to outward consumers.
 * @experimental
 */
export async function readPostgresCatalogStorefrontPage(
  transactions: Pick<PostgresRoleFreeTransactionLane<PgQueryExecutor>, "run">,
  input: CatalogStorefrontPageInput,
): Promise<CatalogStorefrontPageResult> {
  const query = snapshotInput(input);
  if (!query) return withFix({ outcome: "validation_issue", reason: "catalog_offer_memberships_page_input_invalid" });
  const { offerVersion, cursor, limit, regionCode, currency, channel } = query;
  try {
    return await transactions.run(async transaction => {
      let queryFailure: { error: unknown } | undefined;
      const db: PgQueryExecutor = { async query(sql, values) {
        try { return await transaction.query(sql, values); }
        catch (error) {
          queryFailure = { error };
          throw error;
        }
      } };
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { rows } = await db.query("SELECT clock_timestamp() AS at_time");
      const atTime = windowTime(rows[0]?.at_time);
      if (!Number.isFinite(Date.parse(atTime))) throw new Error("Invalid PostgreSQL clock");

      let offerUnpublished = false;
      const membership = await readPostgresCatalogMembershipPage({ async query(sql, values) {
        const result = await db.query(sql, values);
        offerUnpublished = result.rows.length === 1 && unpublished.safeParse(result.rows[0]?.result).success;
        return result;
      } }, { offerVersion, cursor: cursor ?? null, limit, mode: null });
      if ("outcome" in membership) {
        // The membership reader owns specific SQL refusals and also handles invalid evidence
        // returned as data. Preserve the original SQL error when it only returned a generic refusal.
        if (queryFailure && membership.reason === "catalog_publication_read_unavailable") throw queryFailure.error;
        return withFix(offerUnpublished && !cursor ? { ...membership, issue: "offer_unpublished" } : membership);
      }
      if (membership.protocol === "legacy") return { protocol: "legacy", products: [], nextCursor: null };
      const products = await readProjection(db, membership.items);
      if (!Array.isArray(products)) return products;

      const skus = products.flatMap(product => product.skus);
      const context = { regionCode, currency, channel };
      const authority = createCommercePriceAuthorityPort(storefrontPriceReads(db, context, skus));
      const priced = await Promise.allSettled(skus.map(async sku => {
        const lookup = { ...context, variantId: sku.skuId, atTime };
        if (sku.sell.oneTime) sku.price.oneTime = await readPrice(authority, { ...lookup, mode: "one_time" });
        if (sku.sell.subscription) sku.price.subscription = await readPrice(authority, { ...lookup, mode: "subscription" });
      }));
      // Keep the transaction open until the request-scoped price reads have all settled.
      for (const result of priced) if (result.status === "rejected") throw result.reason;
      return { protocol: "governed", headDigest: membership.headDigest, products, nextCursor: membership.nextCursor };
    });
  } catch (error) {
    return failure(error);
  }
}
