/**
 * Typed, single-source feature-flag config service.
 *
 * Behaviour-preserving pass-through over `process.env`: every getter reads the
 * environment PER CALL (no memoization), so runtime flips and per-request env
 * overrides behave exactly as the scattered `process.env.X === "true"` reads it
 * replaces. The named getters mirror the previous local helper names 1:1 so
 * call-site migration is a pure import swap.
 *
 * Combo helpers (checkoutPaymentExecutionEnabled, tpayPaymentExecutionModeEnabled,
 * checkoutPaymentExecutionMissingFlags, checkoutRiskBlockingEnabled,
 * stripeWebhookEnabled) are copied VERBATIM from their original call-sites
 * (server/bff/commerce/checkout.ts, server/bff/payment/webhooks/stripe.ts) to
 * guarantee byte-identical branch order and output tokens.
 */
import { FLAG, SECRET } from "./flagNames.js";

/** Per-call boolean read, identical to `process.env.NAME === "true"`. */
function readBool(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[name] === "true";
}

// --- Simple boolean getters (1:1 with the previous local helpers) ---

export function checkoutLiveEnabled(): boolean {
  return readBool(FLAG.CHECKOUT_LIVE);
}

export function configuratorIntentPersistenceEnabled(): boolean {
  return readBool(FLAG.CONFIGURATOR_INTENT_PERSISTENCE);
}

export function dbBackedQuoteEnabled(): boolean {
  return readBool(FLAG.PRICING_RESOLVER);
}

export function offerPolicyV2Enabled(): boolean {
  return readBool(FLAG.OFFER_POLICY_V2);
}

export function offerPolicyV1FallbackDisabled(): boolean {
  return readBool(FLAG.OFFER_POLICY_V1_FALLBACK_DISABLED);
}

/**
 * Acquisition-only minting gate for the starter-pack offer. The subscription
 * marker itself gates the mechanics; this flag decides only whether a NEW
 * acquisition is given one, so flipping it never changes an existing
 * subscription's deliveries.
 */
export function starterPackEnabled(): boolean {
  return readBool(FLAG.STARTER_PACK);
}

export function offerPolicyV2RolloutBps(): number {
  const value = Number.parseInt(process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS ?? "0", 10);
  return Number.isFinite(value) ? Math.max(0, Math.min(10_000, value)) : 0;
}

export function pricingPolicyTokenSecret(): string | null {
  const value = process.env[SECRET.PRICING_POLICY_TOKEN]?.trim() ?? "";
  return value.length >= 32 ? value : null;
}

export function subscriptionCheckoutContractEnabled(): boolean {
  return readBool(FLAG.SUBSCRIPTION_CHECKOUT_CONTRACT);
}

export function dhlOnlyDeliveryEnabled(): boolean {
  return false;
}

/**
 * Operational hard-disable shared by every outbox drain. Unlike ordinary
 * rollout flags, dispatch is default-on; only the literal value "false" stops
 * it. The database job-control row remains the normal admission gate.
 */
export function outboxDispatchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[FLAG.OUTBOX_DISPATCH] !== "false";
}

// --- Provider/payment single-flag gate getters ---

export function providerPaymentsEnabled(): boolean {
  return readBool(FLAG.PROVIDER_PAYMENTS);
}

export function providerWebhooksEnabled(): boolean {
  return readBool(FLAG.PROVIDER_WEBHOOKS);
}

export function stripeSandboxEnabled(): boolean {
  return readBool(FLAG.STRIPE_SANDBOX);
}

export function tpayEnabled(): boolean {
  return readBool(FLAG.TPAY);
}

export function tpaySandboxEnabled(): boolean {
  return readBool(FLAG.TPAY_SANDBOX);
}

export function tpaySimulatorEnabled(): boolean {
  return readBool(FLAG.TPAY_SIMULATOR);
}

export function tpayVerifiedTestModeEnabled(): boolean {
  return readBool(FLAG.TPAY_VERIFIED_TEST_MODE);
}

export function tpayProductionModeEnabled(): boolean {
  return readBool(FLAG.TPAY_PRODUCTION);
}

// --- Customer self-service gate getters ---

export function customerAuthUiEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readBool(FLAG.CUSTOMER_AUTH_UI, env);
}

export function customerSelfServiceFlagEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readBool(FLAG.CUSTOMER_SELF_SERVICE, env);
}

export function customerAddressesFlagEnabled(): boolean {
  return readBool(FLAG.CUSTOMER_ADDRESSES);
}

export function customerPreferencesFlagEnabled(): boolean {
  return readBool(FLAG.CUSTOMER_PREFERENCES);
}

export function subscriptionMutationsEnabled(): boolean {
  return readBool(FLAG.SUBSCRIPTION_MUTATIONS);
}

export function subscriptionGenericBundleActionsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readBool(FLAG.SUBSCRIPTION_GENERIC_BUNDLE_ACTIONS, env);
}

export function pspRecoveryEnabled(): boolean {
  return readBool(FLAG.PSP_RECOVERY);
}

// --- Combo helpers: copied verbatim (behaviour-preserving) ---

export function checkoutPaymentExecutionEnabled(): boolean {
  if (process.env.COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT === "true") {
    return true;
  }
  if (process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED !== "true") return false;
  return process.env.PAYMENTS_STRIPE_SANDBOX_ENABLED === "true" || tpayPaymentExecutionModeEnabled();
}

export function tpayPaymentExecutionModeEnabled(): boolean {
  if (process.env.PAYMENTS_TPAY_ENABLED !== "true") return false;
  return [
    process.env.PAYMENTS_TPAY_SANDBOX_ENABLED === "true",
    process.env.PAYMENTS_TPAY_SIMULATOR_ENABLED === "true",
    process.env.PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED === "true",
    process.env.PAYMENTS_TPAY_PRODUCTION_ENABLED === "true",
  ].filter(Boolean).length === 1;
}

export function checkoutPaymentExecutionMissingFlags(): string[] {
  const missingFlags: string[] = [];
  if (process.env.COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT !== "true") {
    missingFlags.push("COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT");
  }
  if (process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED !== "true") {
    missingFlags.push("COMMERCE_PROVIDER_PAYMENTS_ENABLED");
  }
  if (
    process.env.PAYMENTS_STRIPE_SANDBOX_ENABLED !== "true" &&
    !tpayPaymentExecutionModeEnabled()
  ) {
    missingFlags.push("PAYMENTS_STRIPE_SANDBOX_ENABLED");
    if (process.env.PAYMENTS_TPAY_ENABLED !== "true") {
      missingFlags.push("PAYMENTS_TPAY_ENABLED");
    } else {
      const tpayModeEnabled = [
        process.env.PAYMENTS_TPAY_SANDBOX_ENABLED === "true",
        process.env.PAYMENTS_TPAY_SIMULATOR_ENABLED === "true",
        process.env.PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED === "true",
        process.env.PAYMENTS_TPAY_PRODUCTION_ENABLED === "true",
      ].filter(Boolean).length;
      if (tpayModeEnabled !== 1) {
        missingFlags.push(
          "PAYMENTS_TPAY_SANDBOX_ENABLED|PAYMENTS_TPAY_SIMULATOR_ENABLED|PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED|PAYMENTS_TPAY_PRODUCTION_ENABLED",
        );
      }
    }
  }
  return missingFlags;
}

export function checkoutRiskBlockingEnabled(): boolean {
  return (
    process.env.COMMERCE_RISK_EVALUATION_ENABLED === "true" &&
    process.env.COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED === "true"
  );
}

export function stripeWebhookEnabled(): boolean {
  return process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED === "true" &&
    process.env.PAYMENTS_STRIPE_SANDBOX_ENABLED === "true";
}

/**
 * Preview-only test-invoice (fakturownia_test) PDF eligibility. Copied verbatim
 * from the two byte-identical accounting read models. VERCEL_ENV is an infra read,
 * kept inline.
 */
export function accountingPreviewTestPdfEligible(): boolean {
  return process.env.COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED === "true" &&
    process.env.COMMERCE_ACCOUNTING_TEST_PDF_ENABLED === "true" &&
    process.env.VERCEL_ENV !== "production";
}

// --- Non-boolean readers (bare secrets) ---

export function riskHashSecret(): string | undefined {
  return process.env[SECRET.RISK_HASH];
}

export function promotionAcceptanceHmacSecret(): string | undefined {
  return process.env[SECRET.PROMOTION_ACCEPTANCE_HMAC];
}

export function promotionAcceptancePreviousHmacSecret(): string | undefined {
  return process.env[SECRET.PROMOTION_ACCEPTANCE_HMAC_PREVIOUS];
}

/**
 * The exact, alphabetically-sorted observability flag list for the checkout
 * route. checkout.ts sources its `featureFlags` from this constant so the
 * observed set can never drift from the names the handler actually gates on.
 */
export const CHECKOUT_OBSERVED_FLAGS: readonly string[] = [
  "COMMERCE_CONFIGURATOR_INTENT_PERSISTENCE_ENABLED",
  "COMMERCE_OFFER_POLICY_V2_ENABLED",
  "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
  "COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED",
  "COMMERCE_RISK_EVALUATION_ENABLED",
  "COMMERCE_STARTER_PACK_ENABLED",
  "COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT",
  "COMMERCE_V2_W11_CHECKOUT_LIVE",
  "COMMERCE_V2_W11_SUBSCRIPTION_CHECKOUT_CONTRACT_ENABLED",
  "COMMERCE_V2_W2_PRICING_RESOLVER",
  "PAYMENTS_STRIPE_SANDBOX_ENABLED",
  "PAYMENTS_TPAY_ENABLED",
  "PAYMENTS_TPAY_PRODUCTION_ENABLED",
  "PAYMENTS_TPAY_SANDBOX_ENABLED",
  "PAYMENTS_TPAY_SIMULATOR_ENABLED",
  "PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED",
] as const;
