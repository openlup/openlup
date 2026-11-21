import type { PgQueryExecutor, PostgresRoleFreeTransactionLane } from "../data/index.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import { catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import type { CatalogSkuRevisionRef } from "./publicationContracts.js";
import { canonicalCatalogPublicationJson, catalogPublishedProductSchema, catalogPublishedSkuSchema, publicationReadinessVerdict } from "./publicationCodec.js";
import { CatalogPublicationError } from "./publicationError.js";
import { assertCatalogPublicationGrossMass } from "./publicationValidation.js";
import { z } from "./validation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const offer = z.string().min(1).max(240)
  .refine(value => value.trim() === value && !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value));
const mode = z.enum(["one_time", "subscription"]).nullable();
const cursor = z.object({ skuId: id, headDigest: digest, offerVersion: offer, mode }).strict();
const pageInput = z.object({ offerVersion: offer, cursor: cursor.nullish(), limit: z.number().int().min(1).max(100), mode: mode.optional() }).strict();
const revision = z.number().int().min(1).max(2_147_483_647);
const code = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u);
const evidence = {
  head: z.object({ publicationId: id, revision, documentDigest: digest }).strict() satisfies z.ZodType<CatalogHeadRef>,
  document: catalogDocumentRevisionRefSchema.extend({ id, productId: id, revisionNo: revision }) satisfies z.ZodType<CatalogDocumentRevisionRef>,
  skuRevision: z.object({ skuId: id, revisionId: id, revision, digest }).strict() satisfies z.ZodType<CatalogSkuRevisionRef>,
};
const member = z.object({
  ...evidence, skuId: id, skuCode: code, productId: id, productSlug: z.string().min(1),
  netWeightG: revision, sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  presentation: z.record(z.string(), z.json()).nullable(),
  logisticsRef: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(),
}).strict();
const page = z.discriminatedUnion("protocol", [
  z.object({ protocol: z.literal("legacy"), headDigest: z.null(), items: z.tuple([]), nextCursor: z.null() }).strict(),
  z.object({ protocol: z.literal("governed"), headDigest: digest, items: z.array(member).max(100), nextCursor: cursor.nullable() }).strict(),
]);
const wire = z.union([
  z.object({ kind: z.literal("page"), value: page }).strict(),
  z.object({ kind: z.literal("refusal"), reason: z.enum(["invalid_request", "unknown_offer", "head_moved"]) }).strict(),
  z.object({ kind: z.literal("refusal"), reason: z.literal("inconsistent_evidence"), detail: z.literal("catalog_publication_live_drift").optional() }).strict(),
]);
const batchInput = z.object({ skuCodes: z.array(code).min(1).max(100).refine(codes => new Set(codes).size === codes.length), expectedHeadDigest: digest }).strict();
const subject = z.object({ ...evidence, product: catalogPublishedProductSchema, sku: catalogPublishedSkuSchema }).strict();
const missing = z.literal("price_readiness_missing"), shape = z.literal("price_shape_invalid");
const batchItem = z.union([
  z.object({ skuCode: code, evidence: z.null(), primaryPresent: z.null(), priceReasons: z.tuple([]) }).strict(),
  z.object({ skuCode: code, evidence: subject, primaryPresent: z.boolean(),
    priceReasons: z.union([z.tuple([]), z.tuple([missing]), z.tuple([shape]), z.tuple([missing, shape])]) }).strict(),
]);
const batchWire = z.union([
  z.object({ kind: z.literal("batch"), value: z.object({ protocol: z.literal("governed"), headDigest: digest, items: z.array(batchItem).min(1).max(100) }).strict() }).strict(),
  z.object({ kind: z.literal("refusal"), reason: z.enum(["invalid_request", "invalid_transaction_mode", "legacy", "head_moved"]) }).strict(),
  z.object({ kind: z.literal("refusal"), reason: z.literal("inconsistent_evidence"), detail: z.enum(["catalog_publication_live_drift",
    "active_price_list_ambiguous", "catalog_price_setup_settlement_context_unverified"]).optional() }).strict(),
]);
// SQL alone owns the two price reasons; installed rules can add other reasons only.
const installedReasons = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u).refine(reason => !["price_readiness_missing", "price_shape_invalid"].includes(reason)));

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
export type CatalogDiscoveryRefusal = { outcome: "validation_issue" | "unauthorized" | "conflict" | "dependency_unavailable"; reason: string; retryable?: true };
/** @experimental */
export type CatalogActivationReadinessInput = { skuCodes: readonly string[]; expectedHeadDigest: string };
/** @experimental */
export type CatalogActivationReadinessItem = { skuCode: string; skuId: string | null; logisticsRef: string | null;
  evidence: CatalogDiscoveryEvidence | null; ready: boolean; reasons: string[] };
/** @experimental */
export type CatalogActivationReadinessResult = { protocol: "governed"; headDigest: string; items: CatalogActivationReadinessItem[] }
  | CatalogDiscoveryRefusal | { outcome: "unsupported"; reason: "catalog_publication_not_adopted" };
/** Installed definitions and trusted host rules. They receive detached certified data after the owner transaction closes.
 * A host without rules passes `assess: () => []`.
 * @experimental
 */
export type CatalogInstalledReadiness = {
  registry: CatalogProductTypeRegistry;
  assess(subject: { product: RulesProduct; sku: RulesSku; evidence: CatalogDiscoveryEvidence }): readonly string[];
};

const unavailable = { outcome: "dependency_unavailable", reason: "catalog_publication_read_unavailable" } as const;
const invalid = { outcome: "validation_issue", reason: "catalog_offer_memberships_page_input_invalid" } as const;
const invalidBatch = { outcome: "validation_issue", reason: "catalog_publication_readiness_input_invalid" } as const;
const installedInvalid = { outcome: "dependency_unavailable", reason: "catalog_installed_readiness_invalid" } as const;

function readError(error: unknown): CatalogDiscoveryRefusal {
  if (!(error instanceof Error) || !("code" in error)) return unavailable;
  if (error.code === "40001") return { outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true };
  if (error.code === "55P03") return { outcome: "conflict", reason: "catalog_publication_read_busy", retryable: true };
  // In this single-function SELECT, aclcheck_error reports position for schema lookup
  // and where for a denial inside the function. Entry-point EXECUTE denial has neither.
  if (error.code === "42501" && "routine" in error && error.routine === "aclcheck_error"
    && !("position" in error && error.position) && !("where" in error && error.where)) {
    return { outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" };
  }
  return unavailable;
}

/** Read one governed page in the caller's statement snapshot.
 * @experimental
 */
export async function readPostgresCatalogMembershipPage(db: PgQueryExecutor, input: CatalogMembershipPageInput): Promise<CatalogMembershipPageResult> {
  const query = pageInput.safeParse(input);
  if (!query.success) return invalid;
  const { offerVersion, cursor: after, limit, mode: requestedMode = null } = query.data;
  if (after && (after.offerVersion !== offerVersion || after.mode !== requestedMode)) return invalid;
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await db.query("SELECT public.catalog_offer_memberships_page($1,$2,$3,$4) AS result", [offerVersion, after ?? null, limit, requestedMode]));
  } catch (error) {
    return readError(error);
  }
  if (rows.length !== 1) return unavailable;
  const decoded = wire.safeParse(rows[0]?.result);
  if (!decoded.success) return unavailable;
  if (decoded.data.kind === "refusal") {
    if (decoded.data.reason === "inconsistent_evidence") return { ...unavailable, reason: decoded.data.detail ?? unavailable.reason };
    if (decoded.data.reason === "head_moved") return { outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true };
    return invalid;
  }
  const { items, nextCursor, headDigest } = decoded.data.value;
  if ((after && headDigest !== after.headDigest) || items.length > limit || items.some((item, index) =>
    item.document.productId !== item.productId || item.head.documentDigest !== item.document.digest || item.skuRevision.skuId !== item.skuId
    || (items[index - 1]?.skuId ?? after?.skuId ?? "") >= item.skuId
    || !((requestedMode !== "subscription" && item.sellableStandalone) || (requestedMode !== "one_time" && item.sellableInSubscription)))
    || (nextCursor && (nextCursor.skuId !== items.at(-1)?.skuId || items.length !== limit || nextCursor.headDigest !== headDigest
      || nextCursor.offerVersion !== offerVersion || nextCursor.mode !== requestedMode))) return unavailable;
  return decoded.data.value;
}

const certified = ({ product, sku, head, document, skuRevision }: z.output<typeof subject>, skuCode: string) =>
  sku.code === skuCode && sku.productId === product.id && skuRevision.skuId === sku.id && document.productId === product.id
  && head.documentDigest === document.digest && canonicalCatalogPublicationJson(product.document) === canonicalCatalogPublicationJson(document);

/** Wait behind publication, read activation readiness on the named owner lane, then apply installed rules.
 * @experimental
 */
export async function readPostgresCatalogActivationReadiness(transactions: Pick<PostgresRoleFreeTransactionLane<PgQueryExecutor>, "run">,
  installed: CatalogInstalledReadiness, input: CatalogActivationReadinessInput): Promise<CatalogActivationReadinessResult> {
  const query = batchInput.safeParse(input);
  // A function is a legacy binder: it is refused without being called.
  if (!query.success || typeof installed !== "object" || installed === null || typeof installed.assess !== "function"
    || typeof installed.registry?.resolve !== "function") return invalidBatch;
  const { skuCodes, expectedHeadDigest } = query.data;
  let result: unknown;
  try {
    result = await transactions.run(async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE");
      const { rows } = await db.query("SELECT public.catalog_publication_activation_readiness($1,$2) AS result", [skuCodes, expectedHeadDigest]);
      return rows.length === 1 ? rows[0]?.result : undefined;
    });
  } catch (error) {
    return readError(error);
  }
  const decoded = batchWire.safeParse(result);
  if (!decoded.success) return unavailable;
  if (decoded.data.kind === "refusal") {
    if (decoded.data.reason === "inconsistent_evidence") return { ...unavailable, reason: decoded.data.detail ?? unavailable.reason };
    if (decoded.data.reason === "head_moved") return { outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true };
    if (decoded.data.reason === "legacy") return { outcome: "unsupported", reason: "catalog_publication_not_adopted" };
    return decoded.data.reason === "invalid_request" ? invalidBatch
      : { outcome: "validation_issue", reason: "catalog_publication_readiness_transaction_invalid" };
  }
  const { headDigest, items } = decoded.data.value;
  if (headDigest !== expectedHeadDigest || items.length !== skuCodes.length
    || items.some((item, index) => item.skuCode !== skuCodes[index] || (item.evidence && !certified(item.evidence, item.skuCode)))) return unavailable;
  const assessed: CatalogActivationReadinessItem[] = [];
  // Host rules see detached copies; certified IDs and evidence are kept from the decoded result.
  try {
    for (const { skuCode, evidence: observed, primaryPresent, priceReasons } of items) {
      if (!observed) {
        assessed.push({ skuCode, skuId: null, logisticsRef: null, evidence: null, ready: false, reasons: ["sku_not_materialized"] });
        continue;
      }
      const { product, sku, ...references } = observed;
      const definition = installed.registry.resolve(structuredClone(product.type));
      if (!definition || definition.key !== product.type.key || definition.version !== product.type.version) return installedInvalid;
      const reasons: string[] = [];
      if (!primaryPresent) reasons.push("primary_sku_missing");
      if (!sku.logisticsRef) reasons.push("logistics_reference_missing");
      if (sku.status === "archived") reasons.push("sku_archived");
      if (product.schemaVersion === 3 && (product.lifecycleState !== "active" || sku.lifecycleState !== "active"
        || (!sku.sellableStandalone && !sku.sellableInSubscription))) reasons.push("catalog_lifecycle_fresh_sale_refused");
      if (!sku.identifiers.some(i => i.scheme === "gs1:gtin" && i.isPrimary && i.packagingLevel === "unit")) reasons.push("unit_gtin_missing");
      try { assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, definition); }
      catch (error) { if (!(error instanceof CatalogPublicationError)) throw error; reasons.push(error.code); }
      reasons.push(...priceReasons);
      if (!product.presentation) reasons.push("presentation_missing");
      if (!sku.memberships.some(row => row.admitted)) reasons.push("offer_membership_missing");
      const assessment: unknown = installed.assess(structuredClone({ product, sku, evidence: references }));
      const then = (assessment as Partial<PromiseLike<unknown>> | null | undefined)?.then;
      if (typeof then === "function") {
        // The assessor contract is synchronous. Observe a returned thenable before refusing it.
        Reflect.apply(then, assessment, [() => undefined, () => undefined]);
        return installedInvalid;
      }
      const extra = installedReasons.safeParse(assessment);
      if (!extra.success) return installedInvalid;
      const combined = [...new Set([...reasons, ...extra.data])];
      const verdict = publicationReadinessVerdict.safeParse({ ready: combined.length === 0, reasons: combined });
      if (!verdict.success) return installedInvalid;
      assessed.push({ skuCode, skuId: sku.id, logisticsRef: sku.logisticsRef, evidence: references, ...verdict.data });
    }
  } catch {
    return installedInvalid;
  }
  return { protocol: "governed", headDigest, items: assessed };
}
