import { MAX_CADENCE_DAYS } from "@openlup/core/subscription";
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
import { catalogAdmissionRefusal } from "../catalogAdmissionRefusal.js";

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
        // A historical command must reach the SQL writer's fingerprint and
        // ownership checks. Receipt existence never authorizes replay by itself.
        const cadenceDays = quote.context?.cadenceDays;
        if (typeof cadenceDays === "number" && cadenceDays > MAX_CADENCE_DAYS) {
          const prior = await executor.query("SELECT 1 FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1", [input.idempotencyKey]);
          if (!prior.rows.length) throw new CommerceOrderDraftPersistenceError(
            `Choose a subscription cadence from 1..${MAX_CADENCE_DAYS} days for a new order draft`,
            { reason: "cadence_limit_exceeded", cadenceDays, maximumCadenceDays: MAX_CADENCE_DAYS });
        }
        // Serialize JSON explicitly: pg treats an unencoded JS array as a
        // PostgreSQL array, not JSON. No gateway or driver coercion is assumed.
        const result = await executor.query(`SELECT public.commerce_create_promoted_order_draft_with_outbox(
          $1::text, $2::jsonb, $3::jsonb, $4::uuid) AS response`,
        [input.idempotencyKey, JSON.stringify(input.quoteSnapshot), JSON.stringify(draft), clientId]);
        response = result.rows[0]?.response;
      } catch (error) {
        if (error instanceof CommerceOrderDraftPersistenceError) throw error;
        const reason = catalogAdmissionRefusal(error);
        if (reason) throw new CommerceOrderDraftPersistenceError(reason, { reason });
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
        const cadenceDays = context?.cadenceDays;
        if (!replay && typeof cadenceDays === "number" && (!Number.isInteger(cadenceDays) || cadenceDays < 1 || cadenceDays > MAX_CADENCE_DAYS)) {
          // Refuse before acquisition policy, eligibility or catalogue owners.
          throw new CommerceOrderDraftPersistenceError(
            `Choose a subscription cadence from 1..${MAX_CADENCE_DAYS} days for a new order draft`,
            { reason: "cadence_limit_exceeded", cadenceDays, maximumCadenceDays: MAX_CADENCE_DAYS });
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
        const result = await persistence.createOrderDraft(request, identity);
        await db.query("COMMIT");
        return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
  };
}

export interface NativeCheckoutOrderRow {
  id: string;
  client_id: string;
  status: string;
  total_amount_minor: number | string;
  currency_code: string;
  metadata: Record<string, unknown>;
  created_at: string | Date;
  recreated_from_order_id: string | null;
}

export interface NativeCheckoutOrderItemRow {
  id: string;
  sku_id: string;
  quantity: number;
}

export interface NativeCheckoutPriorDraftOrderRow {
  id: string;
  status: string;
  total_amount_minor: number | string;
  currency_code: string;
  snapshot: unknown;
  completed: boolean;
}

export interface NativeCheckoutSettlementIntentRow {
  id: string;
  status: string;
  external_ref: string | null;
}

export interface PostgresNativeCheckoutHostPort {
  readOrder(orderId: string): Promise<NativeCheckoutOrderRow | null>;
  readOrderItems(orderId: string): Promise<NativeCheckoutOrderItemRow[]>;
  readPriorDraftOrder(input: {
    idempotencyKey: string;
    clientId: string | null;
    email: string;
    channelKey: string;
  }): Promise<NativeCheckoutPriorDraftOrderRow | null>;
  openSettlementIntent(input: {
    idempotencyKey: string;
    orderId: string;
    channelKey: string;
    amountMinor: number;
    currency: string;
    metadataJson?: string;
    now: string;
  }): Promise<void>;
  readSettlementIntent(input: {
    orderId: string;
    channelKey: string;
  }): Promise<NativeCheckoutSettlementIntentRow | null>;
  readClientEmail(input: {
    clientId: string;
    principalId: string;
  }): Promise<string | null>;
  isInitialCheckoutOrder(orderId: string): Promise<boolean>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Additive PostgreSQL host port for native checkout order reads, settlement
 * intent lifecycle, client email lookup, and initial-order recurring fence.
 */
export function createPostgresNativeCheckoutHostPort(
  executor: NativeCheckoutQuery,
): PostgresNativeCheckoutHostPort {
  return {
    async readOrder(orderId) {
      if (!UUID_PATTERN.test(orderId)) return null;
      const row = (await executor.query(
        `SELECT id,client_id,status,total_amount_minor,currency_code,metadata,created_at,recreated_from_order_id
         FROM public.commerce_orders WHERE id=$1`,
        [orderId],
      )).rows[0];
      return (row as unknown as NativeCheckoutOrderRow | undefined) ?? null;
    },
    async readOrderItems(orderId) {
      const result = await executor.query(
        "SELECT id,sku_id,quantity FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal",
        [orderId],
      );
      return result.rows as unknown as NativeCheckoutOrderItemRow[];
    },
    async readPriorDraftOrder(input) {
      const row = (await executor.query(
        `SELECT o.id,o.status,o.total_amount_minor,o.currency_code,o.metadata->'quoteSnapshot' AS snapshot,
           EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id AND i.channel_key=$4) AS completed
         FROM public.commerce_order_draft_receipts r
         JOIN public.commerce_orders o ON o.id=r.order_id
         JOIN public.clients c ON c.id=o.client_id
         WHERE r.idempotency_key=$1 AND ($2::uuid IS NOT NULL AND c.id=$2 OR $2::uuid IS NULL AND lower(btrim(c.email))=$3)`,
        [input.idempotencyKey, input.clientId, input.email, input.channelKey],
      )).rows[0];
      return (row as unknown as NativeCheckoutPriorDraftOrderRow | undefined) ?? null;
    },
    async openSettlementIntent(input) {
      await executor.query(
        "SELECT public.commerce_open_settlement_intent($1,$2::uuid,$3,$4::bigint,$5,$6::jsonb,$7::timestamptz)",
        [
          input.idempotencyKey,
          input.orderId,
          input.channelKey,
          input.amountMinor,
          input.currency,
          input.metadataJson ?? "{}",
          input.now,
        ],
      );
    },
    async readSettlementIntent(input) {
      const row = (await executor.query(
        "SELECT id,status,external_ref FROM public.commerce_settlement_intents WHERE order_id=$1 AND channel_key=$2",
        [input.orderId, input.channelKey],
      )).rows[0];
      return (row as unknown as NativeCheckoutSettlementIntentRow | undefined) ?? null;
    },
    async readClientEmail(input) {
      const row = (await executor.query(
        "SELECT email FROM public.clients WHERE id=$1 AND principal_id=$2",
        [input.clientId, input.principalId],
      )).rows[0];
      return typeof row?.email === "string" ? row.email : null;
    },
    async isInitialCheckoutOrder(orderId) {
      if (!UUID_PATTERN.test(orderId)) return false;
      const row = (await executor.query(
        `SELECT NOT (
           EXISTS (SELECT 1 FROM public.subscription_cycles cycle
             JOIN public.subscription_renewal_operations operation ON operation.id=cycle.renewal_operation_id
             WHERE cycle.id=orders.subscription_cycle_id)
           OR EXISTS (SELECT 1 FROM public.subscription_retry_obligations obligation
             WHERE obligation.order_id=orders.id OR obligation.cycle_id=orders.subscription_cycle_id)
           OR EXISTS (SELECT 1 FROM public.subscription_dunning_cases cases
             WHERE cases.cycle_id=orders.subscription_cycle_id)
         ) AS initial_checkout FROM public.commerce_orders orders WHERE orders.id=$1::uuid`,
        [orderId],
      )).rows[0];
      return row?.initial_checkout === true;
    },
  };
}
