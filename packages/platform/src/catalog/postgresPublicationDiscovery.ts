import type { PgQueryExecutor, PostgresRoleFreeTransactionLane } from "../data/index.js";
import { CommercePriceAuthorityError, deriveSubscriptionUnitPrice, type CommercePriceAuthorityPort } from "../pricing/index.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import type { CatalogSkuRevisionRef } from "./publicationContracts.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import { catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import { catalogPublishedProductSchema, catalogPublishedSkuSchema, publicationReadinessVerdict } from "./publicationCodec.js";
import { CatalogPublicationError } from "./publicationError.js";
import { assertCatalogPublicationGrossMass } from "./publicationValidation.js";
import { z } from "./validation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const code = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const offer = z.string().min(1).max(240).refine(value => value.trim() === value);
const mode = z.enum(["one_time", "subscription"]).nullable();
const cursor = z.object({ skuId: id, headDigest: digest, offerVersion: offer, mode }).strict();
const pageInput = z.object({ offerVersion: offer, cursor: cursor.nullish(), limit: z.number().int().min(1).max(100), mode: mode.optional() }).strict();
const revision = z.number().int().min(1).max(2_147_483_647);
const evidence = z.object({ head: z.object({ publicationId: id, revision, documentDigest: digest }).strict() satisfies z.ZodType<CatalogHeadRef>,
  document: catalogDocumentRevisionRefSchema satisfies z.ZodType<CatalogDocumentRevisionRef>,
  skuRevision: z.object({ skuId: id, revisionId: id, revision, digest }).strict() satisfies z.ZodType<CatalogSkuRevisionRef> });
const logisticsRef = z.string().min(1).max(500).refine(value => value.trim() === value).nullable();
const member = evidence.extend({ skuId: id, skuCode: code, productId: id, productSlug: z.string().min(1),
  netWeightG: revision, sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  presentation: z.record(z.string(), z.json()).nullable(), logisticsRef }).strict();
const page = z.discriminatedUnion("protocol", [
  z.object({ protocol: z.literal("legacy"), headDigest: z.null(), items: z.tuple([]), nextCursor: z.null() }).strict(),
  z.object({ protocol: z.literal("governed"), headDigest: digest, items: z.array(member).max(100), nextCursor: cursor.nullable() }).strict(),
]);
const batchInput = z.object({ skuCodes: z.array(code).min(1).max(100).refine(codes => new Set(codes).size === codes.length), expectedHeadDigest: digest }).strict();
const settlementContext = z.object({ regionCode: z.string().regex(/^[A-Z]{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u),
  atTime: z.string().refine(value => Number.isFinite(Date.parse(value))).transform(value => new Date(value).toISOString()) }).strict();
const batch = z.object({ protocol: z.literal("governed"), headDigest: digest, context: settlementContext.nullable(), selectedListId: id.nullable(), items: z.array(z.object({ skuCode: code,
  evidence: evidence.extend({ product: catalogPublishedProductSchema, sku: catalogPublishedSkuSchema }).strict().nullable(),
  primaryPresent: z.boolean().nullable(), priceShapeInvalid: z.boolean().nullable(), storedSubscriptionRows: z.number().int().nonnegative().nullable() }).strict()).max(100) }).strict();

/** @experimental */
export type CatalogMembershipCursor = { skuId: string; headDigest: string; offerVersion: string; mode: "one_time" | "subscription" | null };
/** @experimental */
export type CatalogMembershipPageInput = { offerVersion: string; limit: number; mode?: CatalogMembershipCursor["mode"]; cursor?: CatalogMembershipCursor | null };
/** @experimental */
export type CatalogDiscoveryEvidence = { head: CatalogHeadRef; document: CatalogDocumentRevisionRef; skuRevision: CatalogSkuRevisionRef };
/** @experimental */
export type CatalogMembershipItem = CatalogDiscoveryEvidence & { skuId: string; skuCode: string; productId: string; productSlug: string;
  netWeightG: number; sellableStandalone: boolean; sellableInSubscription: boolean; presentation: CatalogPublicationFacts | null; logisticsRef: string | null };
/** @experimental */
export type CatalogMembershipPageResult = { protocol: "legacy"; headDigest: null; items: []; nextCursor: null }
  | { protocol: "governed"; headDigest: string; items: CatalogMembershipItem[]; nextCursor: CatalogMembershipCursor | null }
  | CatalogDiscoveryRefusal;
/** @experimental */
export type CatalogActivationReadinessInput = { skuCodes: readonly string[]; expectedHeadDigest: string };
/** @experimental */
export type CatalogActivationReadinessResult = { protocol: "governed"; headDigest: string; items: Array<{ skuCode: string; skuId: string | null;
  logisticsRef: string | null; evidence: CatalogDiscoveryEvidence | null; ready: boolean; reasons: string[] }> } | CatalogDiscoveryRefusal;
/** @experimental */
export type CatalogDiscoveryRefusal = { outcome: "validation_issue" | "unauthorized" | "unsupported" | "conflict" | "dependency_unavailable"; reason: string; retryable?: true };
/** Bind installed definitions, strict pricing and the subject predicate to the supplied transaction.
 * @experimental
 */
export type CatalogInstalledReadiness = (db: PgQueryExecutor) => {
  registry: CatalogProductTypeRegistry; prices: CommercePriceAuthorityPort; channel: string;
  assess(subject: { product: RulesProduct; sku: RulesSku; evidence: CatalogDiscoveryEvidence }, context: { regionCode: string; currency: string; atTime: string }):
    Promise<{ ready: boolean; reasons: readonly string[] }>;
};

const unavailable = { outcome: "dependency_unavailable", reason: "catalog_publication_read_unavailable" } as const;
const headMoved = "catalog_publication_head_moved";
const invalidPage = "catalog_offer_memberships_page_input_invalid";
const invalidBatch = "catalog_publication_readiness_input_invalid";

function refusal(error: unknown, invalid: string): CatalogDiscoveryRefusal {
  if (!(error instanceof Error) || !("code" in error)) return unavailable;
  if (error.code === "22023" && error.message === invalid) return { outcome: "validation_issue", reason: invalid };
  if (error.code === "42501") return { outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" };
  if (error.code === "55000" && error.message === "catalog_publication_not_adopted") return { outcome: "unsupported", reason: error.message };
  if (error.code === "55P03") return { outcome: "conflict", reason: "catalog_publication_read_busy", retryable: true };
  if (error.code === "40001") return { outcome: "conflict", reason: [headMoved, "catalog_publication_live_drift"].includes(error.message)
    ? error.message : "catalog_publication_transaction_conflict", retryable: true };
  return unavailable;
}
const selected = (row: CatalogDiscoveryEvidence, productId: string, skuId: string) =>
  row.document.productId === productId && row.head.documentDigest === row.document.digest && row.skuRevision.skuId === skuId;

const installedVerdict = z.preprocess(value => {
  if (typeof value !== "object" || value === null || !("reasons" in value) || !Array.isArray(value.reasons)) return value;
  return { ...value, reasons: [...new Set(value.reasons)] };
}, publicationReadinessVerdict);

async function observeInstalled<T>(read: () => T | Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "40001") throw error;
    throw new Error("Installed catalogue observation failed", { cause: error });
  }
}

/** Read one governed page in the caller's catalogue snapshot.
 * @experimental
 */
export async function readPostgresCatalogMembershipPage(db: PgQueryExecutor, input: CatalogMembershipPageInput): Promise<CatalogMembershipPageResult> {
  const query = pageInput.safeParse(input);
  if (!query.success) return { outcome: "validation_issue", reason: invalidPage };
  const { offerVersion, cursor: after, limit, mode: requestedMode = null } = query.data;
  if (after && (after.offerVersion !== offerVersion || after.mode !== requestedMode)) return { outcome: "validation_issue", reason: invalidPage };
  try {
    let transactional = true;
    try { await db.query("SAVEPOINT catalog_membership_read"); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "25P01") throw error;
      transactional = false;
    }
    const { rows } = await db.query("SELECT public.catalog_offer_memberships_page($1,$2,$3,$4) AS result", [offerVersion, after ?? null, limit, requestedMode])
      .catch(async error => {
        if (transactional) {
          await db.query("ROLLBACK TO SAVEPOINT catalog_membership_read");
          await db.query("RELEASE SAVEPOINT catalog_membership_read");
        }
        throw error;
      });
    if (transactional) await db.query("RELEASE SAVEPOINT catalog_membership_read");
    if (rows.length !== 1) return unavailable;
    const result = page.parse(rows[0]?.result);
    const { items, nextCursor, headDigest } = result;
    if ((after && headDigest !== after.headDigest) || items.length > limit || items.some((item, index) =>
      !selected(item, item.productId, item.skuId) || (items[index - 1]?.skuId ?? after?.skuId ?? "") >= item.skuId
      || !((requestedMode !== "subscription" && item.sellableStandalone) || (requestedMode !== "one_time" && item.sellableInSubscription)))
      || (nextCursor && (nextCursor.skuId !== items.at(-1)?.skuId || items.length !== limit || nextCursor.headDigest !== headDigest
        || nextCursor.offerVersion !== offerVersion || nextCursor.mode !== requestedMode))) return unavailable;
    return result;
  } catch (error) { return refusal(error, invalidPage); }
}

// SHARE conflicts with the publication writer's first SHARE ROW EXCLUSIVE lock.
const readerFence = "LOCK TABLE public.catalog_products IN SHARE MODE";

async function priceReason(installed: ReturnType<CatalogInstalledReadiness>, settlement: z.output<typeof settlementContext>,
  sku: RulesSku, selectedListId: string | null, storedSubscriptionRows: number): Promise<string | null> {
  const query = { ...settlement, channel: installed.channel, variantId: sku.id, mode: "subscription" } as const;
  try {
    const money = await installed.prices.resolvePrice(query);
    const matches = (entry: typeof money.base, mode: "one_time" | "subscription") =>
      selectedListId !== null && entry.variantId === sku.id && entry.mode === mode
        && entry.priceListId === selectedListId && entry.resolvedAt === query.atTime;
    if (!matches(money.base, "one_time")) throw new Error("Contradictory base price observation");
    const subscription = money.kind === "subscription_legacy" ? money.legacyResolved : null;
    if (money.kind === "subscription_legacy") {
      if (!matches(money.legacyResolved, "subscription") || money.unitPriceMinor !== money.legacyResolved.unitPriceMinor)
        throw new Error("Contradictory stored subscription price observation");
    } else if (money.kind !== "subscription_policy" || money.policy.priceListId !== selectedListId || money.policy.regionCode !== query.regionCode
      || money.policy.currency !== query.currency || money.policy.channel !== query.channel
      || money.unitPriceMinor !== deriveSubscriptionUnitPrice(money.base.unitPriceMinor, money.policy))
      throw new Error("Contradictory subscription policy observation");
    const exact = (entry: typeof money.base) => entry.amountKind === "gross" && entry.matchedMinQty === 1;
    if (!exact(money.base) || (subscription && !exact(subscription))) return "price_shape_invalid";
    if (![money.base.unitPriceMinor, money.unitPriceMinor].every(Number.isSafeInteger)) throw new Error("Invalid price amount");
    if (money.base.unitPriceMinor <= 0 || money.unitPriceMinor <= 0
      || storedSubscriptionRows !== (money.kind === "subscription_policy" ? 0 : 1)) return "price_readiness_missing";
    return null;
  } catch (error) {
    if (!(error instanceof CommercePriceAuthorityError)) throw error;
    if (error.code === "base_price_amount_kind_invalid") return "price_shape_invalid";
    if (error.code.endsWith("_not_found") || error.code === "subscription_price_policy_not_effective") return "price_readiness_missing";
    throw error;
  }
}

/** Wait for publication before observing catalogue, installed policy and price evidence on the named owner lane.
 * @experimental
 */
export async function readPostgresCatalogActivationReadiness(transactions: Pick<PostgresRoleFreeTransactionLane<PgQueryExecutor>, "run">,
  bind: CatalogInstalledReadiness, input: CatalogActivationReadinessInput): Promise<CatalogActivationReadinessResult> {
  const query = batchInput.safeParse(input);
  if (!query.success) return { outcome: "validation_issue", reason: invalidBatch };
  const { skuCodes, expectedHeadDigest } = query.data;
  try {
    return await transactions.run(async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE");
      await db.query(readerFence);
      const { rows } = await db.query("SELECT public.catalog_publication_activation_readiness($1,$2) AS result", [skuCodes, expectedHeadDigest]);
      if (rows.length !== 1) throw new Error("Invalid catalogue readiness evidence");
      const observed = batch.parse(rows[0]?.result);
      if (observed.headDigest !== expectedHeadDigest || observed.items.length !== skuCodes.length
        || observed.items.some((item, index) => item.skuCode !== skuCodes[index])
        || Boolean(observed.context) !== observed.items.some(item => item.evidence !== null)) throw new Error("Invalid catalogue readiness evidence");
      const settlement = observed.context;
      const installed = settlement && await observeInstalled(() => bind(db));
      const items = [];
      for (const { skuCode, evidence: subject, primaryPresent, priceShapeInvalid, storedSubscriptionRows } of observed.items) {
        if (!subject) {
          if (primaryPresent !== null || priceShapeInvalid !== null || storedSubscriptionRows !== null) throw new Error("Invalid catalogue readiness evidence");
          items.push({ skuCode, skuId: null, logisticsRef: null, evidence: null, ready: false, reasons: ["sku_not_materialized"] });
          continue;
        }
        const { product, sku, ...references } = subject;
        if (!installed || !settlement || primaryPresent === null || priceShapeInvalid === null || storedSubscriptionRows === null || sku.code !== skuCode
          || sku.productId !== product.id || sku.id !== references.skuRevision.skuId || !selected(references, product.id, sku.id)
          || JSON.stringify(product.document) !== JSON.stringify(references.document)) throw new Error("Invalid catalogue readiness evidence");
        const definition = await observeInstalled(() => installed.registry.resolve(product.type));
        if (!definition || definition.key !== product.type.key || definition.version !== product.type.version) throw new Error("Invalid catalogue readiness evidence");
        const reasons: string[] = [];
        if (!primaryPresent) reasons.push("primary_sku_missing");
        if (!sku.logisticsRef) reasons.push("logistics_reference_missing");
        if (sku.status === "archived") reasons.push("sku_archived");
        if (!sku.identifiers.some(i => i.scheme === "gs1:gtin" && i.isPrimary && i.packagingLevel === "unit")) reasons.push("unit_gtin_missing");
        try { assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, definition); }
        catch (error) { if (!(error instanceof CatalogPublicationError)) throw error; reasons.push(error.code); }
        const price = await observeInstalled(() => priceReason(installed, settlement, sku, observed.selectedListId, storedSubscriptionRows));
        if (price) reasons.push(price);
        if (priceShapeInvalid) reasons.push("price_shape_invalid");
        if (!product.presentation) reasons.push("presentation_missing");
        if (!sku.memberships.some(row => row.admitted)) reasons.push("offer_membership_missing");
        const verdict = await observeInstalled(() => installed.assess({ product, sku, evidence: references }, settlement));
        const assessment = installedVerdict.parse(verdict);
        const combined = [...new Set([...reasons, ...assessment.reasons])];
        items.push({ skuCode, skuId: sku.id, logisticsRef: sku.logisticsRef, evidence: references, ready: combined.length === 0, reasons: combined });
      }
      return { protocol: observed.protocol, headDigest: observed.headDigest, items };
    });
  } catch (error) { return refusal(error, invalidBatch); }
}
