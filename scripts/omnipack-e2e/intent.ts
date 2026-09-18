import {
  CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
  CONFIGURATOR_INTENT_VERSION,
  type ConfiguratorIntent,
} from "../../src/domains/commerce/configuratorIntentContracts.ts";
import type { OmnipackCarrierCase } from "./carrierCases.ts";
import { COMMERCE_MIN_ORDER_UNITS } from "../../src/domains/commerce/recommendationPolicyDeps.ts";

// Builds a schema-valid configurator checkout intent for a carrier case. Defaults to a
// subscription (exercises the W1 keystone subscription_initial → OmniPack routing path).
// Flavor slug + SKU defaults are format-valid placeholders; a LIVE run overrides them and
// supplies the active catalog variant id resolved from staging (see README). The shape is
// asserted against configuratorIntentSchema, so the committed builder is provably valid.
export interface BuildIntentOptions {
  variantId: string;
  flavorSlug?: string;
  sku?: string;
  mode?: "one_time" | "subscription";
  cadenceDays?: 14 | 21 | 28;
  email?: string;
  phone?: string;
  idempotencyKey?: string;
}

export function buildE2eCheckoutIntent(
  carrierCase: OmnipackCarrierCase,
  options: BuildIntentOptions,
): ConfiguratorIntent {
  const flavorSlug = options.flavorSlug ?? "kurczak";
  const sku = options.sku ?? "OPENLUP-E2E-KURCZAK-1KG";
  const mode = options.mode ?? "subscription";
  const cadenceDays = mode === "subscription" ? (options.cadenceDays ?? 21) : null;

  const intent: ConfiguratorIntent = {
    version: CONFIGURATOR_INTENT_VERSION,
    cadencePolicyVersion: CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
    idempotencyKey: options.idempotencyKey ?? `omnipack-e2e-${carrierCase.id}-${mode}`,
    locale: "pl",
    mode,
    cadenceDays,
    promoCodes: [],
    visitorId: `omnipack-e2e-${carrierCase.id}`,
    sizeConstraint: { kind: "unit_count", value: COMMERCE_MIN_ORDER_UNITS },
    petProfile: {
      name: "E2E Pies",
      ageBand: "adult",
      breed: "mieszaniec",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: [],
      dailyKcalOverride: null,
    },
    contact: {
      firstName: "E2E",
      lastName: "Tester",
      email: options.email ?? "omnipack-e2e@example.com",
      phone: options.phone ?? "+48500600700",
    },
    address: { street: "ul. Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: carrierCase.selectedDelivery,
    selectedFlavorSlugs: [flavorSlug],
    selectedVariants: [{ variantId: options.variantId, sku, flavorSlug, qty: COMMERCE_MIN_ORDER_UNITS }],
    recommendationSnapshot: null,
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: mode === "subscription" },
    consciousAllergenOverride: false,
  };

  return intent;
}
