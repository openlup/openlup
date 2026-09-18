/** Configurator form state. Persisted copies never include honeypot or business invoice PII. */
import type { PaymentMethod } from "@/domains/checkout/checkoutPaymentMethods";
import type { CompanyIdentityLookupResponse } from "@/domains/company-identity/companyIdentityContracts";
import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import type { DeliveryOption, PickupPoint } from "@/domains/shipping/deliverySelectionContracts";
import { createDefaultConfiguratorFormData, defaultConfiguratorFormData } from "./configuratorFormDefaults";
import { normalizeDeliveryForDhlOnly } from "./normalizeConfiguratorDelivery";
import { clearConfiguratorDraft, flushConfiguratorDraft, getConfiguratorDraft, getConfiguratorDraftStorageKey, PUBLIC_CONFIGURATOR_DRAFT_SCOPE, type ConfiguratorDraftScope, updateConfiguratorDraftForm } from "./configuratorDraftStore";
import { isPersistedPromotionQuoteExpectation, isPersistedPricingPolicyAssignment, type CheckoutQuoteExpectation, type PricingPolicySnapshot } from "./configuratorPricingPolicyPersistence";

export { createDefaultConfiguratorFormData, defaultConfiguratorFormData } from "./configuratorFormDefaults";

// Backwards-compatible export; validation owns the canonical literal union.
export type BundleLengthDays = 14 | 21 | 28;
/** Shipping method enum — keep in sync with `DeliveryMethodCard` UI. */
export type DeliveryMethod = "parcel-locker" | "courier";

export interface BusinessInvoiceAddress {
  line1: string;
  postalCode: string;
  city: string;
  country: "PL";
}

export interface BusinessInvoiceAcceptedData {
  companyName: string;
  taxId: string;
  address: BusinessInvoiceAddress;
}

export interface BusinessInvoiceState {
  requested: boolean;
  taxIdInput: string;
  lookupStatus: "idle" | "loading" | "found" | "not_found" | "error";
  lookupError: string | null;
  lookupResult: CompanyIdentityLookupResponse | null;
  acceptedData: BusinessInvoiceAcceptedData | null;
}

export type { CheckoutQuoteExpectation } from "./configuratorPricingPolicyPersistence";

export interface ConfiguratorFormData {
  /**
   * Account order flow only: the id of the existing account pet this order is
   * for. Seeded by `buildAccountConfiguratorSeed` and threaded into the checkout
   * intent so persistence reuses the existing pet instead of inserting a
   * duplicate profile. Always `null` in the public flow; account drafts keep it
   * only inside their client/pet-scoped intent envelope.
   */
  accountPetId: string | null;

  /** Dog info — populated in step 1 (hero seeds dogName only). */
  dogName: string;
  dogBreed: string;
  dogWeightKg: string;
  dogAge: string;
  activityLevel: string;
  bcs: string;

  /**
   * Whether the dog has any food allergies. Captured explicitly (not
   * derived from `allergens.length`) so the user can answer "tak" and
   * still see a friendly "wybierz co najmniej jeden" error if they
   * haven't ticked anything yet.
   */
  hasAllergies: boolean;

  /**
   * Allergen slugs the dog reacts to. Matches catalog allergen slugs
   * (e.g. `chicken`, `beef`, `lamb`). Used to filter flavors in step 3.
   * Only meaningful when `hasAllergies === true`.
   */
  allergens: string[];

  /**
   * Account order flow only: how each free-text account allergy we could not map
   * was resolved in Step 2 — `raw → slug` (mapped to an allergen) or `raw → "none"`
   * ("not an allergen"). Persists the resolution across step navigation. Always
   * empty in the public flow.
   */
  accountAllergyResolutions: Record<string, string>;

  /** Catalog product slugs selected for the mix (e.g. `lamb`, `venison`). */
  flavors: string[];

  /** True once the flavor step auto-selected all currently safe flavors. */
  flavorSelectionInitialized: boolean;

  /** Bundle length in days. */
  lengthDays: BundleLengthDays;

  /** Automatic calculator recommendation until the customer explicitly picks a cadence. */
  lengthSelectionMode: "automatic" | "manual";

  /** When true, recurring delivery; false = one-time order. */
  subscription: boolean;

  /**
   * Which offer the package step presents. DERIVED, never user-entered: only
   * {@link useConfiguratorStarterOffer} writes it, and ⛔ the draft codec never
   * persists it (see the exclusion note there).
   */
  offerMode: "standard" | "starter";

  /**
   * `feedingCoverageDays` from the server quote that `checkoutQuoteExpectation`
   * was taken from — the ONE input every starter term is derived from. Derived
   * and non-persisted like {@link offerMode}, and cleared in lockstep with the
   * expectation so the two can never describe different quotes.
   */
  starterQuoteCoverageDays: number | null;

  /** Shipping + contact info, populated in step 5. */
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;

  /** Shipping method from step 5. */
  deliveryMethod: DeliveryMethod;
  selectedPickupPoint: PickupPoint | null;
  /**
   * Specific carrier/service tile chosen at step 5 (DPD/DHL/InPost via OmniPack),
   * sourced from GET /delivery-options. Carries the exact carrier/service codes
   * into the checkout intent so dispatch routes to the right OmniPack carrier.
   * `deliveryMethod` stays derived from this option's deliveryKind.
   */
  selectedDeliveryOption: DeliveryOption | null;
  /**
   * Transient: the persisted draft carries only the chosen option's **id**, never
   * the server-authored option (it embeds a price — see the draft codec). On a
   * resumed session step 5 re-resolves this id against a fresh GET
   * /delivery-options and clears it, so a restored selection can never re-submit
   * a stale price or a withdrawn carrier. Never sent to checkout.
   */
  pendingDeliveryOptionId: string | null;

  /** Required and optional consents from step 5. */
  gdprConsent: boolean;
  termsConsent: boolean;
  marketingConsent: boolean;

  /** Selected payment method on step 6 (null until picked). */
  paymentMethod: PaymentMethod | null;

  /** Final-only business invoice data. Never persisted into checkout intent. */
  businessInvoice: BusinessInvoiceState;

  /** Server-authored package recommendation used by summary and checkout. */
  recommendationSnapshot: CommerceRecommendationSnapshot | null;

  /** Sparse customer quantities by variant id; the recommendation stays immutable. */
  packageQuantityOverrides: Record<string, number>;
  /**
   * Promo / coupon codes the user applied on the summary step. Threaded into
   * the live server quote and checkout intent so discounts and caps are
   * resolved server-side.
   */
  promoCodes: string[];

  /** Last Step 5 live quote total, sent to checkout as a drift guard. */
  checkoutQuoteExpectation: CheckoutQuoteExpectation | null;

  /** Server assignment survives compatible quote invalidation and scoped draft resume. */
  pricingPolicyAssignment: PricingPolicySnapshot | null;

  /** Honeypot for basic bot protection. */
  website: string;
}

export type { PaymentMethod }; // composer-local alias; elsewhere import the contract

const storedData = new Map<string, ConfiguratorFormData>();

function hydrateConfiguratorFormData(
  scope: ConfiguratorDraftScope,
  seed?: ConfiguratorFormData,
): ConfiguratorFormData {
  const draft = getConfiguratorDraft(scope);
  const defaults = seed ?? createDefaultConfiguratorFormData();
  return normalizeDeliveryForDhlOnly({
    ...defaults,
    ...draft?.form,
    accountPetId: scope.kind === "account" ? scope.petId : null,
    businessInvoice: defaults.businessInvoice,
    recommendationSnapshot: null,
    // Belt and braces beside the codec exclusion: no draft can resurrect starter mode.
    offerMode: "standard",
    starterQuoteCoverageDays: null,
    checkoutQuoteExpectation: isPersistedPromotionQuoteExpectation(draft?.form.checkoutQuoteExpectation)
      ? draft.form.checkoutQuoteExpectation
      : null,
    pricingPolicyAssignment: isPersistedPricingPolicyAssignment(draft?.form.pricingPolicyAssignment)
      ? draft?.form.pricingPolicyAssignment ?? null
      : null,
    paymentMethod: null,
    // A resumed session restores the consents the customer already ticked, so a
    // returning customer is not asked to re-tick them (operator decision
    // 2026-07-21, superseding the blanket "never persist consent data" rule in
    // docs/plan/configurator-draft-reliability.md). Submitting the order is
    // still the affirmative act that records them.
    gdprConsent: draft?.form.gdprConsent === true,
    termsConsent: draft?.form.termsConsent === true,
    marketingConsent: draft?.form.marketingConsent === true,
    // Re-resolved against a fresh option list at step 5; never restored directly.
    selectedDeliveryOption: null,
    pendingDeliveryOptionId: draft?.form.selectedDeliveryOptionId ?? null,
    website: "",
  });
}

export interface ConfiguratorFormStoreOptions {
  scope?: ConfiguratorDraftScope;
  persist?: boolean;
  flush?: boolean;
}

export const setConfiguratorFormData = (
  data: ConfiguratorFormData,
  options: ConfiguratorFormStoreOptions = {},
): void => {
  const scope = options.scope ?? PUBLIC_CONFIGURATOR_DRAFT_SCOPE;
  const normalized = normalizeDeliveryForDhlOnly(data);
  storedData.set(getConfiguratorDraftStorageKey(scope), normalized);
  if (options.persist !== false) {
    updateConfiguratorDraftForm(normalized, scope);
    if (options.flush) flushConfiguratorDraft(scope);
  }
};

export const getConfiguratorFormData = (
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  seed?: ConfiguratorFormData,
): ConfiguratorFormData => {
  const key = getConfiguratorDraftStorageKey(scope);
  const current = storedData.get(key) ?? hydrateConfiguratorFormData(scope, seed);
  const normalized = normalizeDeliveryForDhlOnly(current);
  storedData.set(key, normalized);
  return normalized;
};

/**
 * Seed the in-memory form state, optionally WITHOUT persisting to localStorage.
 *
 * Callers may still opt out for transient hosts. Account flows normally use a
 * client/pet-scoped draft, so they cannot clobber the public-flow state.
 * `persist` defaults to true to match {@link setConfiguratorFormData}.
 */
export const seedConfiguratorFormData = (
  data: ConfiguratorFormData,
  options: ConfiguratorFormStoreOptions = {},
): void => {
  const scope = options.scope ?? PUBLIC_CONFIGURATOR_DRAFT_SCOPE;
  const seeded = normalizeDeliveryForDhlOnly({
    ...data,
    accountPetId: scope.kind === "account" ? scope.petId : null,
  });
  storedData.set(getConfiguratorDraftStorageKey(scope), seeded);
  if (options.persist !== false) {
    updateConfiguratorDraftForm(seeded, scope);
    if (options.flush) flushConfiguratorDraft(scope);
  }
};

/** Explicit reset: drop in-memory state and the selected persisted draft. */
export const resetConfiguratorFormData = (
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void => {
  storedData.set(
    getConfiguratorDraftStorageKey(scope),
    normalizeDeliveryForDhlOnly(createDefaultConfiguratorFormData()),
  );
  clearConfiguratorDraft(scope);
};

/** Clear persistence after payment; account memory has no public recap consumer. */
export const clearPersistedConfiguratorFormData = (
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void => {
  if (scope.kind === "account") storedData.delete(getConfiguratorDraftStorageKey(scope));
  clearConfiguratorDraft(scope);
};

export const clearConfiguratorFormMemory = (
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void => {
  storedData.delete(getConfiguratorDraftStorageKey(scope));
};

/** Display-safe pet name (falls back to a generic if empty). */
export const getDogNameOrFallback = (data: ConfiguratorFormData): string =>
  data.dogName.trim() || "Twojego pupila";
