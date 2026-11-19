import { z } from "zod";
import type { PromotionRow } from "@openlup/core/promo";
import { selectAcquisitionTerms, assertAcquisitionTermsCapability, AcquisitionTermsError, resolvedAcquisitionTermsSchema,
  createCommerceQuoteSchemas, COMMERCE_CONTRACT_VERSION, OFFER_POLICY_V2, isAuthoritativeSubscriptionPolicyQuoteLine, type CreateQuoteResponse,
  type AcquisitionFinancialPolicy, type CommerceQuoteDiscount } from "../../../pricing/index.js";
import { createPostgresQuoteCustomerEligibility } from "../../../promotions/index.js";
import { commerceIdempotencyKeySchema } from "../../contractPrimitives.js";
import type { CommerceOfferAvailabilityPort } from "../../contracts/availability.js";
import { commerceOfferEvidenceSchema } from "../../offerEvidenceSchemas.js";
import type { OrderDraftSummary } from "../../contracts/order.js";
import { CommerceOrderDraftConflictError, CommerceOrderDraftInvalidResponseError, CommerceOrderDraftPersistenceError } from "../../errors.js";
import { CommerceOrderDraftPriceChangedError, CommerceOrderDraftUnsupportedMoneyError } from "../../orderDraftErrors.js";

export interface NativeCheckoutQuery {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface NativeCheckoutDraftRequest {
  idempotencyKey: string;
  quoteSnapshot: CreateQuoteResponse;
}

/** Trusted native draft identity and quote-time evidence. Never parse it from a browser request.
 * @experimental
 */
export interface NativeCheckoutAdmissionIdentity {
  clientId?: string | null;
  catalogAdmission?: object | null;
}

export interface NativeCheckoutDraftResponse {
  contractVersion: typeof COMMERCE_CONTRACT_VERSION;
  orderDraft: OrderDraftSummary<CreateQuoteResponse["quote"], typeof COMMERCE_CONTRACT_VERSION>;
}

const { createQuoteResponseSchema } = createCommerceQuoteSchemas({
  currencySchema: z.string().regex(/^[A-Z]{3}$/),
  productSlugSchema: z.string().trim().min(1),
  contextSchema: z.object({
    mode: z.enum(["one_time", "subscription"]),
    cadenceDays: z.number().int().positive().max(2_147_483_647).nullable().optional(),
    promoCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  }).passthrough(),
});
const requestSchema = z.object({
  idempotencyKey: commerceIdempotencyKeySchema,
  quoteSnapshot: createQuoteResponseSchema,
}).strict();
const clientIdSchema = z.guid().nullable();
const responseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  orderDraft: z.object({
    orderId: z.string().regex(/^order_[0-9a-f-]{36}$/),
    status: z.literal("draft"),
    paymentStatus: z.literal("not_started"),
    idempotencyKey: commerceIdempotencyKeySchema,
    quoteSnapshot: createQuoteResponseSchema,
    replayed: z.boolean(),
  }),
});

/**
 * qualified-v2 order persistence only. Bind a restricted runtime executor;
 * supply the server-produced quote and route-authorized client out of band.
 * Changed requests refuse without superseding or dispatching a payment.
 */
export function createPostgresNativeCheckoutPersistence(
  executor: NativeCheckoutQuery,
): {
  createOrderDraft(request: NativeCheckoutDraftRequest, options?: NativeCheckoutAdmissionIdentity): Promise<NativeCheckoutDraftResponse>;
} {
  return nativeCheckoutPersistence(executor);
}

function nativeCheckoutPersistence(executor: NativeCheckoutQuery, policyRegion?: string) {
  return {
    async createOrderDraft(request: NativeCheckoutDraftRequest, options?: NativeCheckoutAdmissionIdentity): Promise<NativeCheckoutDraftResponse> {
      const input = requestSchema.parse(request);
      const clientId = clientIdSchema.parse(options?.clientId ?? null);
      const { quote } = input.quoteSnapshot;
      const draft = {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        source: "commerce.order_draft.bff.v0",
        status: "draft",
        paymentStatus: "not_started",
        currency: quote.currency,
        taxIncluded: quote.taxIncluded,
        lines: quote.lines,
        discounts: quote.discounts,
        context: quote.context,
        totals: {
          subtotalGross: quote.subtotalGross,
          discountTotalGross: quote.discountTotalGross,
          shippingGross: quote.shippingGross,
          shippingDiscountGross: quote.shippingDiscountGross,
          totalGross: quote.totalGross,
          netTotal: quote.netTotal,
          taxTotal: quote.taxTotal,
        },
      };
      let response: unknown;
      try {
        // Serialize JSON explicitly: pg treats an unencoded JS array as a
        // PostgreSQL array, not JSON. No gateway or driver coercion is assumed.
        const routine = policyRegion === undefined ? "commerce_create_promoted_order_draft_with_outbox" : "catalog_admission_create_policy_draft";
        const result = await executor.query(`SELECT public.${routine}(
          $1::text, $2::jsonb, $3::jsonb, $4::uuid${policyRegion === undefined ? "" : ", $5::text"}) AS response`,
        [input.idempotencyKey, JSON.stringify(options?.catalogAdmission == null ? input.quoteSnapshot : { ...input.quoteSnapshot, catalogAdmission: options.catalogAdmission }),
          JSON.stringify(draft), clientId, ...(policyRegion === undefined ? [] : [policyRegion])]);
        response = result.rows[0]?.response;
      } catch (error) {
        const { code, message } = (error && typeof error === "object" ? error : {}) as { code?: string; message?: string };
        if (code === "23505" || code === "40001") {
          throw new CommerceOrderDraftConflictError(undefined, { code });
        }
        if (message?.includes("commerce_order_draft_catalog_price_changed")) {
          throw new CommerceOrderDraftPriceChangedError("Commerce catalog price changed", { code });
        }
        if (message?.includes("commerce_promoted_net_shipping_unsupported")) {
          throw new CommerceOrderDraftUnsupportedMoneyError("net_shipping_unsupported");
        }
        if (message?.includes("commerce_promotion_line_allocation_unsupported")) {
          throw new CommerceOrderDraftUnsupportedMoneyError("line_promotion_unsupported");
        }
        if (message?.includes("commerce_zero_payable_order_unsupported")) {
          throw new CommerceOrderDraftUnsupportedMoneyError("zero_payable_unsupported");
        }
        throw new CommerceOrderDraftPersistenceError(undefined, { code });
      }
      const parsed = responseSchema.safeParse(response);
      if (!parsed.success) throw new CommerceOrderDraftInvalidResponseError();
      return parsed.data;
    },
  };
}

export interface NativeAcquisitionCheckoutPool {
  connect(): Promise<NativeCheckoutQuery & { release(): void }>;
}
export interface NativeAcquisitionCheckoutOptions {
  regionCode: string;
  financialPolicy: AcquisitionFinancialPolicy<PromotionRow>;
  /** Host-owned semantic labels, in addition to the saved family IDs. */
  isAcquisitionDiscount(discount: CommerceQuoteDiscount): boolean;
  /** The host's existing availability authority for governed sized quotes.
   * @experimental
   */
  availability?: CommerceOfferAvailabilityPort;
}

interface CheckoutStockSelection {
  offerEvidence: { offerVersion: string };
  mode: "one_time" | "subscription";
  skuRevisions: readonly { reference: { skuId: string; skuCode: string }; quantity: number }[];
}

/** @experimental */
interface CheckoutQuoteHead {
  productId: string;
  head: { publicationId: string; revision: number; documentDigest: string };
}

async function assertSizedCheckoutStock(quote: CreateQuoteResponse["quote"], evidence: CheckoutStockSelection,
  availability: CommerceOfferAvailabilityPort | undefined) {
  const refusal = "catalog_admission_sized_stock_unavailable";
  const context = quote.context as Record<string, unknown> | undefined;
  if (context?.offerVersion !== "sized.v1" || !commerceOfferEvidenceSchema.safeParse(context.offerEvidence).success) {
    throw new Error("catalog_admission_sized_offer_binding_required");
  }
  if (!availability) throw new Error(refusal);
  const linesBySku = new Map(quote.lines.map(line => [line.sku, line]));
  const items = evidence.skuRevisions.map(({ reference, quantity }) => {
    const line = linesBySku.get(reference.skuCode);
    if (!line || line.quantity !== quantity) throw new Error(refusal);
    return { sku: line.sku, productSlug: line.productSlug, variantId: reference.skuId, requestedQuantity: quantity,
      checkoutMode: evidence.mode };
  });
  const results = await availability.getAvailability({ items });
  const stockByVariant = new Map(results.map(stock => [stock.variantId, stock]));
  if (results.length !== items.length || stockByVariant.size !== items.length || items.some(item => {
    const stock = stockByVariant.get(item.variantId);
    return !stock || stock.sku !== item.sku || stock.productSlug !== item.productSlug || !stock.visibleInConfigurator
      || (stock.status !== "available" && stock.status !== "low_stock")
      || typeof stock.sellableNow !== "number" || !Number.isSafeInteger(stock.sellableNow) || stock.sellableNow < item.requestedQuantity;
  })) throw new Error(refusal);
}

/** Server-produced quotes only. Owns one READ COMMITTED transaction through draft
 * commit; host authorization and quote acceptance precede this boundary. */
export function createPostgresAcquisitionCheckoutPersistence(pool: NativeAcquisitionCheckoutPool, options: NativeAcquisitionCheckoutOptions) {
  return {
    /** Reads offer membership and price evidence for a server-produced quote in one snapshot.
     * Governed quotes supply the product heads observed by their trusted quote reader.
     * @experimental
     */
    async captureCatalogAdmission(quoteSnapshot: CreateQuoteResponse, quoteTimeHeads?: readonly CheckoutQuoteHead[]): Promise<object | null> {
      const snapshot = createQuoteResponseSchema.parse(quoteSnapshot);
      const db = await pool.connect();
      let evidence: CheckoutStockSelection | null;
      try {
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        const result = await db.query(
          "SELECT public.catalog_admission_build_evidence($1::jsonb,$2::text,$3::jsonb,'order') AS evidence",
          [JSON.stringify(snapshot.quote.lines), snapshot.quote.context?.mode ?? "one_time", JSON.stringify({ quoteSnapshot: snapshot, quoteTimeHeads })],
        );
        evidence = (result.rows[0]?.evidence ?? null) as CheckoutStockSelection | null;
        await db.query("COMMIT");
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
      if (evidence?.offerEvidence.offerVersion === "sized.v1") {
        await assertSizedCheckoutStock(snapshot.quote, evidence, options.availability);
      }
      return evidence;
    },
    async createOrderDraft(request: NativeCheckoutDraftRequest, identity?: NativeCheckoutAdmissionIdentity) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const key = commerceIdempotencyKeySchema.parse(request.idempotencyKey);
        await db.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))", [key]);
        // The existing writer owns replay, changed-input and ownership validation.
        const replay = (await db.query(`SELECT o.metadata#>'{quoteSnapshot,catalogAdmission}' AS evidence
          FROM public.commerce_order_draft_receipts r JOIN public.commerce_orders o ON o.id=r.order_id
          WHERE r.idempotency_key=$1`, [key])).rows[0];
        const context = request.quoteSnapshot.quote.context as Record<string, unknown> | undefined;
        const policies = request.quoteSnapshot.quote.lines.filter(line => line.catalogFacts?.version === "catalog_facts_v2");
        const policyOwner = !replay && identity?.catalogAdmission != null && policies.length > 0;
        if (policyOwner && !policies.every(isAuthoritativeSubscriptionPolicyQuoteLine)) {
          throw new Error("catalog_admission_quote_authority_required");
        }
        if (!replay && context?.mode === "subscription") {
          const policy = options.financialPolicy;
          const read = async () => (await db.query("SELECT promotion_id,definition,active FROM public.commerce_promotion_definitions ORDER BY promotion_id")).rows;
          const scoped = (row: Record<string, unknown>) => {
            const definition = row.definition as PromotionRow;
            return policy.facts(definition).regionCodes.includes(options.regionCode)
              && (policy.facts(definition).metadataPresent || policy.classify(definition).canonicalRow);
          };
          const before = (await read()).filter(scoped);
          for (const row of before) await db.query("SELECT * FROM public.commerce_promotion_lock_definition($1::text)", [row.promotion_id]);
          const current = (await read()).filter(scoped);
          const changed = () => { throw new Error("acquisition_terms_changed"); };
          if (JSON.stringify(current.map(row => row.promotion_id)) !== JSON.stringify(before.map(row => row.promotion_id))) changed();
          const { discounts } = request.quoteSnapshot.quote;
          const candidate = context.acquisitionTerms;
          const starter = context.starterPack as { delivery2?: { discountBps?: unknown } } | null | undefined;
          const hasGrant = discounts.some(discount => options.isAcquisitionDiscount(discount)
            || current.some(row => row.promotion_id === discount.promotionId));
          const paid = await createPostgresQuoteCustomerEligibility(db).hasPaidSubscription(identity?.clientId ?? null);
          const configured = current.some(row => policy.facts(row.definition as PromotionRow).metadataPresent);
          if (!(candidate === undefined && (starter == null && !hasGrant && paid || !configured))) {
            const now = (await db.query("SELECT clock_timestamp()::text AS instant")).rows[0]!.instant;
            const rows = current.map(row => ({ ...(row.definition as PromotionRow),
              status: row.active ? (row.definition as PromotionRow).status : "paused" }));
            const selected = selectAcquisitionTerms(rows, String(now), options.regionCode, policy);
            if (!selected && configured) {
              throw new AcquisitionTermsError("acquisition_terms_not_effective");
            }
            if (selected) {
              const pricing = context.pricingPolicy as { offerPolicyVersion?: unknown; promotionEngineVersion?: unknown } | undefined;
              assertAcquisitionTermsCapability(selected, context.acquisitionCapability, pricing?.promotionEngineVersion);
              if (selected.kind === "v2_standalone" && pricing?.offerPolicyVersion !== OFFER_POLICY_V2) changed();
              if (!(candidate === undefined && selected.kind === "legacy_pair")) {
                const parsed = resolvedAcquisitionTermsSchema.safeParse(candidate);
                if (!parsed.success) changed();
                else if (Object.entries(selected.terms).some(([key, value]) => parsed.data[key as keyof typeof parsed.data] !== value)) changed();
              }
              if (starter != null && starter.delivery2?.discountBps !== selected.terms.delivery2DiscountBps) changed();
            } else if (candidate !== undefined || starter != null || hasGrant) changed();
          }
        }
        const result = await nativeCheckoutPersistence(db, policyOwner ? options.regionCode : undefined).createOrderDraft(request, replay
          ? { clientId: identity?.clientId, catalogAdmission: replay.evidence == null ? undefined : replay.evidence as object }
          : identity);
        await db.query("COMMIT");
        return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
  };
}
