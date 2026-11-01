import { z } from "zod";
import { createCommerceQuoteSchemas, COMMERCE_CONTRACT_VERSION, type CreateQuoteResponse } from "../../pricing/index.js";
import { commerceIdempotencyKeySchema } from "../contractPrimitives.js";
import type { OrderDraftSummary } from "../contracts/order.js";
import { CommerceOrderDraftConflictError, CommerceOrderDraftInvalidResponseError, CommerceOrderDraftPersistenceError } from "../errors.js";
import { CommerceOrderDraftPriceChangedError, CommerceOrderDraftUnsupportedMoneyError } from "../orderDraftErrors.js";

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
