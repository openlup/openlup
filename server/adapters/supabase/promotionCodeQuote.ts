import { z } from "zod";

import type {
  PromotionCodeQuotePort,
  ResolvedPromotionCodeCandidate,
} from "../../domains/commerce/promotionCodeQuotePort.js";
import { PROMOTION_CODE_QUOTE_RPC } from "../../domains/commerce/promotionCodeQuotePort.js";
import type { CommerceCodeRejectionDetail } from "../../../src/domains/commerce/types.js";

const candidateSchema = z
  .object({
    promotionId: z.string().uuid(),
    codeId: z.string().uuid(),
    code: z.string().trim().min(1).max(80),
    codeRevision: z.number().int().positive(),
    definitionFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    minimumReferenceMinor: z.number().int().nonnegative(),
    // The RPC builds candidates with jsonb_strip_nulls, so an unbounded
    // validity window arrives without this property. Normalize that wire shape
    // to the domain's canonical null instead of rejecting an otherwise valid
    // active code and failing the whole quote.
    validTo: z.string().datetime({ offset: true }).nullable().default(null),
    name: z.string().trim().min(1).max(120),
    source: z.literal("code"),
    scopes: z.array(z.enum(["one_time", "subscription_initial"])).min(1).max(2),
    lane: z.enum(["product", "shipping"]),
    kind: z.enum(["target_percentage", "percentage", "fixed_amount", "free_shipping"]),
    valueBps: z.number().int().min(1).max(9_999).optional(),
    valueMinor: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    const percentage = candidate.kind === "target_percentage" || candidate.kind === "percentage";
    if (percentage !== (candidate.valueBps !== undefined) ||
        (candidate.kind === "fixed_amount") !== (candidate.valueMinor !== undefined)) {
      context.addIssue({ code: "custom", message: "promotion candidate value mismatch" });
    }
    if (candidate.kind === "free_shipping" && (candidate.valueBps !== undefined || candidate.valueMinor !== undefined)) {
      context.addIssue({ code: "custom", message: "free shipping candidate cannot carry a value" });
    }
  });

const codeRejectionSchema = z.object({
  code: z.string().trim().min(1).max(80),
  reason: z.enum(["not_recognized", "already_used", "not_eligible", "expired"]),
}).strict();

const rejectionDetailSchema = z.discriminatedUnion("reason", [
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("scope_not_applicable"),
    allowedScopes: z.array(z.enum(["one_time", "subscription_initial"])).min(1).max(2),
  }).strict(),
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("minimum_not_met"),
    minimumReferenceMinor: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("not_yet_active"),
    validFrom: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("global_limit_reached"),
  }).strict(),
]);

const legacyResponseSchema = z.object({
  candidates: z.array(candidateSchema),
  codeRejections: z.array(codeRejectionSchema),
}).strict();

const v2ResponseSchema = legacyResponseSchema.extend({
  codeRejectionDetails: z.array(rejectionDetailSchema),
}).strict();

interface RpcError {
  code?: string;
  message?: string;
}

export interface PromotionCodeQuoteRpcClient {
  rpc(
    functionName: "commerce_promotion_codes_quote_candidates" | "commerce_promotion_codes_quote_candidates_v2",
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export function createSupabasePromotionCodeQuotePort(
  client: PromotionCodeQuoteRpcClient,
): PromotionCodeQuotePort {
  return {
    async resolve(input) {
      const args = {
        p_codes: input.codes,
        p_client_id: input.clientId,
        p_scope: input.purchaseScope,
        p_reference_product_minor: input.referenceProductMinor,
        p_at: input.atTime,
      };
      const v2 = await client.rpc(PROMOTION_CODE_QUOTE_RPC.current, args);
      if (!v2.error) {
        const parsed = v2ResponseSchema.parse(v2.data);
        return {
          // unknown-hop: the parsed shape has no direct overlap with the candidate
          // union under tsconfig.node.json's non-strict program
          candidates: parsed.candidates as unknown as ResolvedPromotionCodeCandidate[],
          codeRejections: parsed.codeRejections,
          codeRejectionDetails: parsed.codeRejectionDetails as CommerceCodeRejectionDetail[],
        };
      }
      if (!isMissingQuoteCandidatesV2(v2.error)) {
        throw new Error(`promotion_code_quote_read_failed:${v2.error.code ?? "unknown"}`);
      }

      const legacy = await client.rpc(PROMOTION_CODE_QUOTE_RPC.legacy, args);
      if (legacy.error) throw new Error(`promotion_code_quote_read_failed:${legacy.error.code ?? "unknown"}`);
      const parsed = legacyResponseSchema.parse(legacy.data);
      return {
        candidates: parsed.candidates as unknown as ResolvedPromotionCodeCandidate[],
        codeRejections: parsed.codeRejections,
        codeRejectionDetails: [],
      };
    },
  };
}

/** Only a deployment race where the additive RPC is absent may use v1. */
function isMissingQuoteCandidatesV2(error: RpcError): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}
