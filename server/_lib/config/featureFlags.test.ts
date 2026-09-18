import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRequire } from "node:module";

import {
  CHECKOUT_OBSERVED_FLAGS,
  accountingPreviewTestPdfEligible,
  checkoutLiveEnabled,
  checkoutPaymentExecutionEnabled,
  checkoutPaymentExecutionMissingFlags,
  checkoutRiskBlockingEnabled,
  configuratorIntentPersistenceEnabled,
  customerAddressesFlagEnabled,
  customerAuthUiEnabled,
  customerPreferencesFlagEnabled,
  customerSelfServiceFlagEnabled,
  dbBackedQuoteEnabled,
  dhlOnlyDeliveryEnabled,
  offerPolicyV1FallbackDisabled,
  offerPolicyV2Enabled,
  offerPolicyV2RolloutBps,
  outboxDispatchEnabled,
  pricingPolicyTokenSecret,
  providerPaymentsEnabled,
  providerWebhooksEnabled,
  pspRecoveryEnabled,
  riskHashSecret,
  stripeSandboxEnabled,
  stripeWebhookEnabled,
  subscriptionCheckoutContractEnabled,
  subscriptionGenericBundleActionsEnabled,
  subscriptionMutationsEnabled,
  starterPackEnabled,
  tpayEnabled,
  tpayPaymentExecutionModeEnabled,
  tpayProductionModeEnabled,
  tpaySandboxEnabled,
  tpaySimulatorEnabled,
  tpayVerifiedTestModeEnabled,
} from "./featureFlags.js";
import { GOVERNED_FLAG_NAMES } from "./flagNames.js";

// --- Verbatim oracles, copied from the original call-sites. Comparing the
// service output to these under an identical env is the byte-identity proof. ---

function oracleCheckoutLiveEnabled(): boolean {
  return process.env.COMMERCE_V2_W11_CHECKOUT_LIVE === "true";
}
function oracleConfiguratorIntentPersistenceEnabled(): boolean {
  return process.env.COMMERCE_CONFIGURATOR_INTENT_PERSISTENCE_ENABLED === "true";
}
function oracleDbBackedQuoteEnabled(): boolean {
  return process.env.COMMERCE_V2_W2_PRICING_RESOLVER === "true";
}
function oracleSubscriptionCheckoutContractEnabled(): boolean {
  return process.env.COMMERCE_V2_W11_SUBSCRIPTION_CHECKOUT_CONTRACT_ENABLED === "true";
}
function oracleTpayMode(): boolean {
  if (process.env.PAYMENTS_TPAY_ENABLED !== "true") return false;
  return [
    process.env.PAYMENTS_TPAY_SANDBOX_ENABLED === "true",
    process.env.PAYMENTS_TPAY_SIMULATOR_ENABLED === "true",
    process.env.PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED === "true",
    process.env.PAYMENTS_TPAY_PRODUCTION_ENABLED === "true",
  ].filter(Boolean).length === 1;
}
function oracleCheckoutPaymentExecutionEnabled(): boolean {
  if (process.env.COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT === "true") {
    return true;
  }
  if (process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED !== "true") return false;
  return process.env.PAYMENTS_STRIPE_SANDBOX_ENABLED === "true" || oracleTpayMode();
}
function oracleStripeWebhookEnabled(): boolean {
  return process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED === "true" &&
    process.env.PAYMENTS_STRIPE_SANDBOX_ENABLED === "true";
}
function oracleCheckoutRiskBlockingEnabled(): boolean {
  return (
    process.env.COMMERCE_RISK_EVALUATION_ENABLED === "true" &&
    process.env.COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED === "true"
  );
}

const PAYMENT_CLUSTER = [
  "COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT",
  "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
  "PAYMENTS_STRIPE_SANDBOX_ENABLED",
  "PAYMENTS_TPAY_ENABLED",
  "PAYMENTS_TPAY_SANDBOX_ENABLED",
  "PAYMENTS_TPAY_SIMULATOR_ENABLED",
  "PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED",
  "PAYMENTS_TPAY_PRODUCTION_ENABLED",
] as const;

let saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  // Snapshot every var these tests touch so each case starts from a clean slate.
  const touched = [
    ...PAYMENT_CLUSTER,
    "COMMERCE_PROVIDER_WEBHOOKS_ENABLED",
    "COMMERCE_V2_W11_CHECKOUT_LIVE",
    "COMMERCE_CONFIGURATOR_INTENT_PERSISTENCE_ENABLED",
    "COMMERCE_V2_W2_PRICING_RESOLVER",
    "COMMERCE_V2_W11_SUBSCRIPTION_CHECKOUT_CONTRACT_ENABLED",
    "COMMERCE_DHL_ONLY_DELIVERY",
    "COMMERCE_RISK_EVALUATION_ENABLED",
    "COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED",
    "COMMERCE_RISK_HASH_SECRET",
    "COMMERCE_OFFER_POLICY_V2_ENABLED",
    "COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS",
    "COMMERCE_PRICING_POLICY_TOKEN_SECRET",
    "COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED",
    "COMMERCE_ACCOUNTING_TEST_PDF_ENABLED",
    "VERCEL_ENV",
    "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
    "COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED",
    "COMMERCE_CUSTOMER_ADDRESSES_ENABLED",
    "COMMERCE_CUSTOMER_PREFERENCES_ENABLED",
    "COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED",
    "COMMERCE_SUBSCRIPTION_GENERIC_BUNDLE_ACTIONS_ENABLED",
    "COMMERCE_PSP_RECOVERY_ENABLED",
    "COMMERCE_OUTBOX_DISPATCH_ENABLED",
    "COMMERCE_STARTER_PACK_ENABLED",
  ];
  saved = {};
  for (const k of touched) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) setEnv(k, v);
});

describe("simple boolean getters match their original expression", () => {
  const cases: Array<[() => boolean, () => boolean, string]> = [
    [checkoutLiveEnabled, oracleCheckoutLiveEnabled, "COMMERCE_V2_W11_CHECKOUT_LIVE"],
    [configuratorIntentPersistenceEnabled, oracleConfiguratorIntentPersistenceEnabled, "COMMERCE_CONFIGURATOR_INTENT_PERSISTENCE_ENABLED"],
    [dbBackedQuoteEnabled, oracleDbBackedQuoteEnabled, "COMMERCE_V2_W2_PRICING_RESOLVER"],
    [subscriptionCheckoutContractEnabled, oracleSubscriptionCheckoutContractEnabled, "COMMERCE_V2_W11_SUBSCRIPTION_CHECKOUT_CONTRACT_ENABLED"],
  ];
  for (const [getter, oracle, name] of cases) {
    for (const value of ["true", "false", "TRUE", " true", "1", undefined]) {
      it(`${name}=${String(value)} matches oracle and is strict`, () => {
        setEnv(name, value);
        expect(getter()).toBe(oracle());
        expect(getter()).toBe(value === "true");
      });
    }
  }

  it("permanently retires the direct-DHL checkout override despite a hostile env", () => {
    process.env.COMMERCE_DHL_ONLY_DELIVERY = "true";
    expect(dhlOnlyDeliveryEnabled()).toBe(false);
  });
});

describe("outbox dispatch operational hard-disable", () => {
  it.each([
    [undefined, true],
    ["true", true],
    ["false", false],
    ["FALSE", true],
  ])("maps %s to enabled=%s", (value, expected) => {
    setEnv("COMMERCE_OUTBOX_DISPATCH_ENABLED", value);
    expect(outboxDispatchEnabled()).toBe(expected);
    expect(outboxDispatchEnabled({ COMMERCE_OUTBOX_DISPATCH_ENABLED: value })).toBe(expected);
  });
});

describe("provider/payment single-flag getters are strict reads of their flag", () => {
  const getterCases: Array<[() => boolean, string]> = [
    [providerPaymentsEnabled, "COMMERCE_PROVIDER_PAYMENTS_ENABLED"],
    [providerWebhooksEnabled, "COMMERCE_PROVIDER_WEBHOOKS_ENABLED"],
    [stripeSandboxEnabled, "PAYMENTS_STRIPE_SANDBOX_ENABLED"],
    [tpayEnabled, "PAYMENTS_TPAY_ENABLED"],
    [tpaySandboxEnabled, "PAYMENTS_TPAY_SANDBOX_ENABLED"],
    [tpaySimulatorEnabled, "PAYMENTS_TPAY_SIMULATOR_ENABLED"],
    [tpayVerifiedTestModeEnabled, "PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED"],
    [tpayProductionModeEnabled, "PAYMENTS_TPAY_PRODUCTION_ENABLED"],
  ];
  for (const [getter, name] of getterCases) {
    for (const value of ["true", "false", "TRUE", undefined]) {
      it(`${name}=${String(value)} -> ${value === "true"}`, () => {
        setEnv(name, value);
        expect(getter()).toBe(value === "true");
      });
    }
  }
});

describe("customer self-service single-flag getters are strict reads", () => {
  const getterCases: Array<[() => boolean, string]> = [
    [customerAuthUiEnabled, "COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
    [customerSelfServiceFlagEnabled, "COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED"],
    [customerAddressesFlagEnabled, "COMMERCE_CUSTOMER_ADDRESSES_ENABLED"],
    [customerPreferencesFlagEnabled, "COMMERCE_CUSTOMER_PREFERENCES_ENABLED"],
    [subscriptionMutationsEnabled, "COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED"],
    [subscriptionGenericBundleActionsEnabled, "COMMERCE_SUBSCRIPTION_GENERIC_BUNDLE_ACTIONS_ENABLED"],
    [pspRecoveryEnabled, "COMMERCE_PSP_RECOVERY_ENABLED"],
    [starterPackEnabled, "COMMERCE_STARTER_PACK_ENABLED"],
  ];
  for (const [getter, name] of getterCases) {
    for (const value of ["true", "false", "TRUE", undefined]) {
      it(`${name}=${String(value)} -> ${value === "true"}`, () => {
        setEnv(name, value);
        expect(getter()).toBe(value === "true");
      });
    }
  }
});

function* paymentCombos(): Generator<Array<string | undefined>> {
  // 2^8 over {undefined, "true"} — only "true" is truthy for these gates, so this
  // covers every meaningful branch; a few non-"true" strings are checked separately.
  const n = PAYMENT_CLUSTER.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    yield PAYMENT_CLUSTER.map((_, i) => ((mask >> i) & 1 ? "true" : undefined));
  }
}

describe("payment combo helpers are byte-identical to oracles across the cluster", () => {
  it("matches across all 2^8 true/unset combinations", () => {
    for (const combo of paymentCombos()) {
      PAYMENT_CLUSTER.forEach((name, i) => setEnv(name, combo[i]));
      expect(checkoutPaymentExecutionEnabled()).toBe(oracleCheckoutPaymentExecutionEnabled());
      expect(tpayPaymentExecutionModeEnabled()).toBe(oracleTpayMode());
      expect(stripeWebhookEnabled()).toBe(oracleStripeWebhookEnabled());
      expect(checkoutPaymentExecutionMissingFlags()).toEqual(
        oracleMissingFlags(),
      );
    }
  });

  it("treats non-\"true\" strings as disabled (strict equality)", () => {
    for (const name of PAYMENT_CLUSTER) setEnv(name, "false");
    expect(checkoutPaymentExecutionEnabled()).toBe(false);
    setEnv("COMMERCE_PROVIDER_PAYMENTS_ENABLED", "1");
    expect(checkoutPaymentExecutionEnabled()).toBe(false);
  });
});

// Verbatim oracle for missingFlags, kept separate to mirror the source exactly.
function oracleMissingFlags(): string[] {
  const missingFlags: string[] = [];
  if (process.env.COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT !== "true") {
    missingFlags.push("COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT");
  }
  if (process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED !== "true") {
    missingFlags.push("COMMERCE_PROVIDER_PAYMENTS_ENABLED");
  }
  if (
    process.env.PAYMENTS_STRIPE_SANDBOX_ENABLED !== "true" &&
    !oracleTpayMode()
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

describe("checkoutPaymentExecutionMissingFlags exact branch arrays", () => {
  it("no provider flags set -> rehearsal + provider + stripe + tpay missing", () => {
    expect(checkoutPaymentExecutionMissingFlags()).toEqual([
      "COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT",
      "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
      "PAYMENTS_STRIPE_SANDBOX_ENABLED",
      "PAYMENTS_TPAY_ENABLED",
    ]);
  });

  it("provider on, tpay on, zero tpay modes -> the pipe-joined mode token", () => {
    setEnv("COMMERCE_PROVIDER_PAYMENTS_ENABLED", "true");
    setEnv("PAYMENTS_TPAY_ENABLED", "true");
    expect(checkoutPaymentExecutionMissingFlags()).toEqual([
      "COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT",
      "PAYMENTS_STRIPE_SANDBOX_ENABLED",
      "PAYMENTS_TPAY_SANDBOX_ENABLED|PAYMENTS_TPAY_SIMULATOR_ENABLED|PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED|PAYMENTS_TPAY_PRODUCTION_ENABLED",
    ]);
  });

  it("provider on, tpay on, exactly one tpay mode -> only rehearsal missing", () => {
    setEnv("COMMERCE_PROVIDER_PAYMENTS_ENABLED", "true");
    setEnv("PAYMENTS_TPAY_ENABLED", "true");
    setEnv("PAYMENTS_TPAY_SANDBOX_ENABLED", "true");
    expect(checkoutPaymentExecutionMissingFlags()).toEqual([
      "COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT",
    ]);
  });

  it("rehearsal on still reports the other gates (missingFlags does not short-circuit)", () => {
    // Verbatim behaviour: rehearsal short-circuits checkoutPaymentExecutionEnabled,
    // but missingFlags only suppresses the rehearsal token itself and keeps reporting
    // the provider/stripe/tpay gates. Preserved exactly.
    setEnv("COMMERCE_V2_W11_ALLOW_HIDDEN_REHEARSAL_PAYMENT", "true");
    expect(checkoutPaymentExecutionMissingFlags()).toEqual([
      "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
      "PAYMENTS_STRIPE_SANDBOX_ENABLED",
      "PAYMENTS_TPAY_ENABLED",
    ]);
  });
});

describe("checkoutRiskBlockingEnabled", () => {
  it("requires both risk flags", () => {
    expect(checkoutRiskBlockingEnabled()).toBe(false);
    setEnv("COMMERCE_RISK_EVALUATION_ENABLED", "true");
    expect(checkoutRiskBlockingEnabled()).toBe(oracleCheckoutRiskBlockingEnabled());
    expect(checkoutRiskBlockingEnabled()).toBe(false);
    setEnv("COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED", "true");
    expect(checkoutRiskBlockingEnabled()).toBe(true);
  });
});

describe("accountingPreviewTestPdfEligible truth table", () => {
  it("requires both accounting flags AND a non-production VERCEL_ENV", () => {
    expect(accountingPreviewTestPdfEligible()).toBe(false);
    setEnv("COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED", "true");
    setEnv("COMMERCE_ACCOUNTING_TEST_PDF_ENABLED", "true");
    expect(accountingPreviewTestPdfEligible()).toBe(true); // VERCEL_ENV unset !== "production"
    setEnv("VERCEL_ENV", "preview");
    expect(accountingPreviewTestPdfEligible()).toBe(true);
    setEnv("VERCEL_ENV", "production");
    expect(accountingPreviewTestPdfEligible()).toBe(false);
    setEnv("VERCEL_ENV", "preview");
    setEnv("COMMERCE_ACCOUNTING_TEST_PDF_ENABLED", undefined);
    expect(accountingPreviewTestPdfEligible()).toBe(false);
  });
});

describe("riskHashSecret is a bare passthrough (undefined when unset)", () => {
  it("returns the raw string or undefined", () => {
    expect(riskHashSecret()).toBeUndefined();
    setEnv("COMMERCE_RISK_HASH_SECRET", "s3cr3t");
    expect(riskHashSecret()).toBe("s3cr3t");
  });
});

describe("offer policy v2 config defaults closed", () => {
  it("requires the flag, clamps rollout, and rejects short signing secrets", () => {
    expect(offerPolicyV1FallbackDisabled()).toBe(false);
    expect(offerPolicyV2Enabled()).toBe(false);
    expect(offerPolicyV2RolloutBps()).toBe(0);
    expect(pricingPolicyTokenSecret()).toBeNull();
    setEnv("COMMERCE_OFFER_POLICY_V2_ENABLED", "true");
    setEnv("COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED", "true");
    setEnv("COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS", "20000");
    setEnv("COMMERCE_PRICING_POLICY_TOKEN_SECRET", "too-short");
    expect(offerPolicyV2Enabled()).toBe(true);
    expect(offerPolicyV1FallbackDisabled()).toBe(true);
    expect(offerPolicyV2RolloutBps()).toBe(10_000);
    expect(pricingPolicyTokenSecret()).toBeNull();
  });
});

describe("per-call (non-memoized) reads", () => {
  it("reflects process.env mutations between calls", () => {
    expect(checkoutLiveEnabled()).toBe(false);
    setEnv("COMMERCE_V2_W11_CHECKOUT_LIVE", "true");
    expect(checkoutLiveEnabled()).toBe(true);
    setEnv("COMMERCE_V2_W11_CHECKOUT_LIVE", "false");
    expect(checkoutLiveEnabled()).toBe(false);
  });
});

describe("CHECKOUT_OBSERVED_FLAGS", () => {
  it("deep-equals the exact 15 alphabetically-sorted names", () => {
    expect([...CHECKOUT_OBSERVED_FLAGS]).toEqual([
      "COMMERCE_CONFIGURATOR_INTENT_PERSISTENCE_ENABLED",
      "COMMERCE_OFFER_POLICY_V2_ENABLED",
      "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
      "COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED",
      "COMMERCE_RISK_EVALUATION_ENABLED",
      // Starter-pack signal lane: metadata only. The route gate stays
      // COMMERCE_V2_W11_CHECKOUT_LIVE; this flag gates the starter branch inside
      // the quote guard.
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
    ]);
  });

  it("is sorted and has 16 entries", () => {
    expect(CHECKOUT_OBSERVED_FLAGS).toHaveLength(16);
    expect([...CHECKOUT_OBSERVED_FLAGS]).toEqual([...CHECKOUT_OBSERVED_FLAGS].sort());
  });
});

describe("governed flag names are real registry entries (no typos / orphans)", () => {
  it("every GOVERNED_FLAG_NAMES entry is registered in config/feature-flags.json", () => {
    const require = createRequire(import.meta.url);
    const registry = require("../../../config/feature-flags.json") as {
      flags: Array<{ name: string }>;
    };
    const registered = new Set(registry.flags.map((f) => f.name));
    for (const name of GOVERNED_FLAG_NAMES) {
      expect(registered.has(name), `${name} missing from config/feature-flags.json`).toBe(true);
    }
  });
});
