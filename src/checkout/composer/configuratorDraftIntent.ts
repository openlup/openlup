/**
 * The form half of a saved configurator draft: the answers a draft keeps, and
 * the read-side checks that stop an unreadable value from reaching the form.
 * `configuratorDraftCodec` writes it and re-exports the type.
 */
import { commerceOfferVersionSchema } from "@/domains/commerce/offerVersionContracts";

import type { ConfiguratorFormData } from "./configuratorFormStore";
import {
  isPersistedPromotionQuoteExpectation,
  isPersistedPricingPolicyAssignment,
  type CheckoutQuoteExpectation,
  type PricingPolicySnapshot,
} from "./configuratorPricingPolicyPersistence";

export interface ConfiguratorDraftIntent {
  accountPetId?: string | null;
  dogName: string;
  dogBreed: string;
  dogWeightKg: string;
  dogAge: string;
  activityLevel: string;
  bcs: string;
  hasAllergies: boolean;
  allergens: string[];
  accountAllergyResolutions: Record<string, string>;
  flavors: string[];
  flavorSelectionInitialized: boolean;
  lengthDays: 14 | 21 | 28;
  lengthSelectionMode: "automatic" | "manual";
  subscription: boolean;
  packageQuantityOverrides: Record<string, number>;
  promoCodes: string[];
  checkoutQuoteExpectation?: CheckoutQuoteExpectation;
  pricingPolicyAssignment?: PricingPolicySnapshot | null;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  deliveryMethod?: ConfiguratorFormData["deliveryMethod"];
  selectedPickupPoint?: ConfiguratorFormData["selectedPickupPoint"];
  /**
   * Id only — never the resolved `DeliveryOption`, which embeds a server-authored
   * price. Step 5 re-resolves it against a fresh GET /delivery-options, so a
   * withdrawn or re-priced carrier restores as "nothing selected" rather than as
   * a stale quote.
   */
  selectedDeliveryOptionId?: string;
  gdprConsent?: boolean;
  termsConsent?: boolean;
  marketingConsent?: boolean;
  /**
   * The adopter offer version the session was answered with. Written only as a
   * string; {@link withReadableOfferVersion} drops an unreadable value on read.
   */
  offerVersion?: string;
}

export function isConfiguratorDraftIntent(value: ConfiguratorDraftIntent): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.dogName === "string" &&
      typeof value.dogBreed === "string" &&
      typeof value.dogWeightKg === "string" &&
      typeof value.subscription === "boolean" &&
      Array.isArray(value.allergens) &&
      Array.isArray(value.flavors) &&
      Array.isArray(value.promoCodes) &&
      (value.checkoutQuoteExpectation == null ||
        isPersistedPromotionQuoteExpectation(value.checkoutQuoteExpectation)) &&
      isPersistedPricingPolicyAssignment(value.pricingPolicyAssignment) &&
      isOptionalBoolean(value.gdprConsent) &&
      isOptionalBoolean(value.termsConsent) &&
      isOptionalBoolean(value.marketingConsent) &&
      (value.selectedDeliveryOptionId === undefined ||
        typeof value.selectedDeliveryOptionId === "string") &&
      (value.lengthDays === 14 || value.lengthDays === 21 || value.lengthDays === 28),
  );
}

function isOptionalBoolean(value: boolean | undefined): boolean {
  return value === undefined || typeof value === "boolean";
}

/**
 * Drops an offer version that fails `commerceOfferVersionSchema` and returns the
 * same draft otherwise. It runs after the envelope check on purpose: a failed
 * check clears the whole draft, and one unreadable field must not cost a
 * customer the rest of the draft.
 */
export function withReadableOfferVersion<T extends { form: ConfiguratorDraftIntent }>(draft: T): T {
  const offerVersion: unknown = draft.form.offerVersion;
  if (offerVersion === undefined || commerceOfferVersionSchema.safeParse(offerVersion).success) return draft;
  const { offerVersion: _unreadable, ...form } = draft.form;
  return { ...draft, form };
}
