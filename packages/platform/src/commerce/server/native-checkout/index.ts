import { z } from "zod";
import type { PromotionRow } from "@openlup/core/promo";
import { selectAcquisitionTerms, assertAcquisitionTermsCapability, AcquisitionTermsError, resolvedAcquisitionTermsSchema,
  createCommerceQuoteSchemas, COMMERCE_CONTRACT_VERSION, OFFER_POLICY_V2, type CreateQuoteResponse,
  type AcquisitionFinancialPolicy, type CommerceQuoteDiscount } from "../../../pricing/index.js";
import { createPostgresQuoteCustomerEligibility } from "../../../promotions/index.js";
import { commerceIdempotencyKeySchema } from "../../contractPrimitives.js";
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

export interface NativeCheckoutDraftResponse {
  contractVersion: typeof COMMERCE_CONTRACT_VERSION;
  orderDraft: OrderDraftSummary<CreateQuoteResponse["quote"], typeof COMMERCE_CONTRACT_VERSION>;
}

const { createQuoteResponseSchema } = createCommerceQuoteSchemas({
  currencySchema: z.string().regex(/^[A-Z]{3}$/),
  productSlugSchema: z.string().trim().min(1),
  contextSchema: z.object({
    mode: z.enum(["one_time", "subscription"]),
    cadenceDays: z.number().int().positive().max(120).nullable().optional(),
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
  createOrderDraft(request: NativeCheckoutDraftRequest, options?: { clientId?: string | null }): Promise<NativeCheckoutDraftResponse>;
} {
  return {
    async createOrderDraft(request, options) {
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
        const result = await executor.query(`SELECT public.commerce_create_promoted_order_draft_with_outbox(
          $1::text, $2::jsonb, $3::jsonb, $4::uuid) AS response`,
        [input.idempotencyKey, JSON.stringify(input.quoteSnapshot), JSON.stringify(draft), clientId]);
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
}

/** Server-produced quotes only. Owns one READ COMMITTED transaction through draft
 * commit; host authorization and quote acceptance precede this boundary. */
export function createPostgresAcquisitionCheckoutPersistence(pool: NativeAcquisitionCheckoutPool, options: NativeAcquisitionCheckoutOptions) {
  return {
    async createOrderDraft(request: NativeCheckoutDraftRequest, identity?: { clientId?: string | null }) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const key = commerceIdempotencyKeySchema.parse(request.idempotencyKey);
        await db.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))", [key]);
        const persistence = createPostgresNativeCheckoutPersistence(db);
        // The existing writer owns replay, changed-input and ownership validation.
        const replay = (await db.query("SELECT 1 FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1", [key])).rows.length > 0;
        const context = request.quoteSnapshot.quote.context as Record<string, unknown> | undefined;
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
        const result = await persistence.createOrderDraft(request, identity);
        await db.query("COMMIT");
        return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
  };
}
