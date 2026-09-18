import {
  consoleOperationalEventRecorder,
  type OperationalEventRecorder,
} from "../../_lib/observability/operationalEvents.js";
import type { PromotionPurchaseScope } from "../../../src/domains/promo/types.js";
import type { PromotionQuoteMismatchField } from "./promotionQuoteBinding.js";

export const PROMOTION_ACCEPTANCE_STAGES = [
  "quote_issue",
  "quote_honor",
  "checkout_verify",
] as const;
export const PROMOTION_ACCEPTANCE_OUTCOMES = ["issued", "accepted", "rejected", "skipped"] as const;
export const PROMOTION_ACCEPTANCE_REASONS = [
  "issued",
  "accepted",
  "no_v2_adjustment",
  "secret_unavailable",
  "malformed",
  "unknown_key",
  "signature_invalid",
  "not_yet_valid",
  "expired",
  "ttl_invalid",
  "request_mismatch",
  "code_mismatch",
  "quote_mismatch",
  "total_mismatch",
  "currency_mismatch",
  "no_v2_adjustment_in_quote",
] as const;
export const PROMOTION_ACCEPTANCE_KEY_SLOTS = ["current", "previous", "none"] as const;
export const PROMOTION_ACCEPTANCE_EXPIRY_BUCKETS = [
  "expired",
  "lt_1h",
  "1_24h",
  "24_72h",
  "none",
] as const;

export type PromotionAcceptanceTelemetry = {
  stage: (typeof PROMOTION_ACCEPTANCE_STAGES)[number];
  outcome: (typeof PROMOTION_ACCEPTANCE_OUTCOMES)[number];
  reason: (typeof PROMOTION_ACCEPTANCE_REASONS)[number];
  keySlot: (typeof PROMOTION_ACCEPTANCE_KEY_SLOTS)[number];
  purchaseScope: PromotionPurchaseScope;
  expiryBucket: (typeof PROMOTION_ACCEPTANCE_EXPIRY_BUCKETS)[number];
  promotionEngineVersion: "promotion-engine.v2";
  /**
   * Only a `quote_mismatch` carries one: which section of the bound money
   * projection diverged, so the next divergence names its field in the log
   * drain without a redeploy. `other` = the token predates section bindings.
   */
  mismatchField?: PromotionQuoteMismatchField;
};

export function recordPromotionAcceptanceOutcome(
  details: PromotionAcceptanceTelemetry,
  surface: "public" | "hidden",
  recorder: OperationalEventRecorder = consoleOperationalEventRecorder,
): void {
  try {
    recorder({
      name: "commerce_promotion_acceptance_outcome",
      domain: "commerce",
      surface,
      details,
    });
  } catch {
    // Telemetry is passive evidence. It must never change quote/checkout truth.
  }
}
