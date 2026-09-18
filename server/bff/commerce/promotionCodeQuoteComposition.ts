import {
  promotionAcceptanceHmacSecret,
  promotionAcceptancePreviousHmacSecret,
} from "../../_lib/config/featureFlags.js";
import {
  createSupabasePromotionCodeQuotePort,
  type PromotionCodeQuoteRpcClient,
} from "../../adapters/supabase/promotionCodeQuote.js";
import {
  issuePromotionQuoteAcceptanceWithOutcome,
  verifyPromotionQuoteAcceptanceWithOutcome,
  type PromotionAcceptanceKeyring,
} from "../../domains/commerce/promotionQuoteAcceptance.js";
import {
  recordPromotionAcceptanceOutcome,
  type PromotionAcceptanceTelemetry,
} from "../../domains/commerce/promotionAcceptanceTelemetry.js";
import {
  publicCreateQuoteRequestSchema,
  type CreateQuoteRequest,
} from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuote } from "../../../src/domains/commerce/types.js";

type AcceptanceRecorder = (
  input: PromotionAcceptanceTelemetry,
  surface: "public" | "hidden",
) => void;

/**
 * v2 promotion codes are a permanent part of checkout (the ISSUE/HONOR rollout
 * flags were retired in PR 2243), so the quote port is always constructed. The
 * two former variants — issue (`ISSUE && HONOR`) and honor-only (the bounded
 * drain) — collapse into this single unconditional factory: issuing a signed
 * promotion quote always implied being able to verify it, so "always issue" and
 * "always honor" are the same state.
 */
export function createPromotionCodeQuotePort(client: unknown) {
  return createSupabasePromotionCodeQuotePort(client as PromotionCodeQuoteRpcClient);
}

export function readPromotionAcceptanceKeyring() {
  const current = promotionAcceptanceHmacSecret();
  if (!current || current.length < 32) return null;
  return { current, previous: promotionAcceptancePreviousHmacSecret() };
}

export function createRoutePromotionAcceptanceIssuer(
  acceptanceKeyring: PromotionAcceptanceKeyring | null,
  recorder: AcceptanceRecorder = recordPromotionAcceptanceOutcome,
) {
  return (request: CreateQuoteRequest, quote: CommerceQuote): string | null => {
    const hasV2CodeAdjustment = quote.discounts.some((discount) =>
      discount.promotionEngineVersion === "promotion-engine.v2" &&
      discount.reasonCode === "promotion_code_v2");
    if (!hasV2CodeAdjustment) return null;
    if (!acceptanceKeyring) {
      recorder({
        stage: "quote_issue", outcome: "rejected", reason: "secret_unavailable",
        keySlot: "none",
        purchaseScope: request.mode === "subscription" ? "subscription_initial" : "one_time",
        expiryBucket: "none", promotionEngineVersion: "promotion-engine.v2",
      }, "public");
      throw new Error("promotion_acceptance_secret_missing");
    }
    const result = issuePromotionQuoteAcceptanceWithOutcome({
      request, quote, keyring: acceptanceKeyring,
    });
    if (request.promoCodes.length > 0 || result.token) {
      recorder({
        stage: "quote_issue", outcome: result.token ? "issued" : "skipped",
        reason: result.diagnostic.reason, keySlot: result.diagnostic.keySlot,
        purchaseScope: request.mode === "subscription" ? "subscription_initial" : "one_time",
        expiryBucket: result.diagnostic.expiryBucket,
        promotionEngineVersion: "promotion-engine.v2",
      }, "public");
    }
    return result.token;
  };
}

export function recordRouteMissingPromotionHonorSecret(
  body: unknown,
  acceptanceKeyring: PromotionAcceptanceKeyring | null,
  recorder: AcceptanceRecorder = recordPromotionAcceptanceOutcome,
): void {
  const request = publicCreateQuoteRequestSchema.safeParse(body);
  if (!request.success || !request.data.promotionAcceptanceToken || acceptanceKeyring) return;
  recorder({
    stage: "quote_honor", outcome: "rejected", reason: "secret_unavailable",
    keySlot: "none",
    purchaseScope: request.data.mode === "subscription" ? "subscription_initial" : "one_time",
    expiryBucket: "none", promotionEngineVersion: "promotion-engine.v2",
  }, "public");
}

export function createRoutePromotionAcceptanceHonorer(
  acceptanceKeyring: PromotionAcceptanceKeyring | null,
  recorder: AcceptanceRecorder = recordPromotionAcceptanceOutcome,
) {
  if (!acceptanceKeyring) return undefined;
  return (token: string, request: CreateQuoteRequest, quote: CommerceQuote): boolean => {
    const result = verifyPromotionQuoteAcceptanceWithOutcome({
      token, request, quote, expectedTotal: quote.totalGross, keyring: acceptanceKeyring,
    });
    recorder({
      stage: "quote_honor", outcome: result.accepted ? "accepted" : "rejected",
      reason: result.reason, keySlot: result.keySlot,
      purchaseScope: request.mode === "subscription" ? "subscription_initial" : "one_time",
      expiryBucket: result.expiryBucket, promotionEngineVersion: "promotion-engine.v2",
      ...(result.mismatchField ? { mismatchField: result.mismatchField } : {}),
    }, "public");
    return result.accepted;
  };
}
