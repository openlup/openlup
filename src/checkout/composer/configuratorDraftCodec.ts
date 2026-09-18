import {
  createPersistedState,
  type PersistedState,
} from "@/lib/persistentCommerceState";

import type { ConfiguratorStepId } from "./configuratorStepOrder";

import type { ConfiguratorFormData } from "./configuratorFormStore";
import { resolveConfiguratorDraftSteps, withConfiguratorStepIds } from "./configuratorDraftStepIds";
import {
  isPersistedPromotionQuoteExpectation,
  isPersistedPricingPolicyAssignment,
  type CheckoutQuoteExpectation,
  type PricingPolicySnapshot,
} from "./configuratorPricingPolicyPersistence";

export const CONFIGURATOR_DRAFT_VERSION = 2;
export const CONFIGURATOR_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const LEGACY_FORM_KEY = "openlup:configurator:v1";
export const LEGACY_STEP_KEY = "openlup:configurator:step:v1";
export const LEGACY_MAX_STEP_KEY = "openlup:configurator:maxstep:v1";

export type ConfiguratorDraftScope =
  | { kind: "public" }
  | { kind: "account"; clientId: string; petId: string | null };

export const PUBLIC_CONFIGURATOR_DRAFT_SCOPE: ConfiguratorDraftScope = { kind: "public" };

export function createAccountConfiguratorDraftScope(
  clientId: string,
  petId: string | null = null,
): ConfiguratorDraftScope {
  return { kind: "account", clientId, petId };
}

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
}

export interface ConfiguratorDraftEnvelope {
  form: ConfiguratorDraftIntent;
  step: number;
  maxStep: number;
  /**
   * The same two positions addressed by identity instead of by number, written
   * on every save and preferred on read. Both are optional: a draft saved
   * before they existed has neither. See `configuratorDraftStepIds`.
   *
   * ⛔ Deliberately additive, with NO {@link CONFIGURATOR_DRAFT_VERSION} bump: a
   * version mismatch makes `persistentCommerceState` CLEAR the draft, which
   * would destroy a customer's in-flight order. An older bundle reading a newer
   * draft ignores these two fields and keeps using `step`/`maxStep`.
   */
  stepId?: ConfiguratorStepId;
  maxStepId?: ConfiguratorStepId;
}

export function getConfiguratorDraftStorageKey(scope: ConfiguratorDraftScope): string {
  if (scope.kind === "public") return "openlup:configurator:draft:v2";
  const client = encodeURIComponent(scope.clientId.trim());
  const subject = scope.petId ? `pet:${encodeURIComponent(scope.petId)}` : "new";
  return `openlup:account-configurator:${client}:${subject}:v2`;
}

export function serializeConfiguratorIntent(
  data: ConfiguratorFormData,
  scope: ConfiguratorDraftScope,
): ConfiguratorDraftIntent {
  const common: ConfiguratorDraftIntent = {
    accountPetId: scope.kind === "account" ? scope.petId : undefined,
    dogName: data.dogName,
    dogBreed: data.dogBreed,
    dogWeightKg: data.dogWeightKg,
    dogAge: data.dogAge,
    activityLevel: data.activityLevel,
    bcs: data.bcs,
    hasAllergies: data.hasAllergies,
    allergens: [...data.allergens],
    accountAllergyResolutions: { ...data.accountAllergyResolutions },
    flavors: [...data.flavors],
    flavorSelectionInitialized: data.flavorSelectionInitialized,
    lengthDays: data.lengthDays,
    lengthSelectionMode: data.lengthSelectionMode,
    subscription: data.subscription,
    // ⛔ `offerMode` is deliberately absent from this allowlist and from
    // {@link ConfiguratorDraftIntent}. It is not a customer choice — it is a live
    // server signal ("this email is first-order eligible AND the starter offer is
    // being served"). Persisting it would let a draft restored days later put a
    // customer back into an acquisition offer they are no longer entitled to; the
    // package step would show a starter price the checkout guard then rejects.
    // Starter mode is re-earned from the eligibility endpoint on every session.
    // `configuratorDraftCodec.test.ts` pins that no serialized draft carries it.
    packageQuantityOverrides: { ...data.packageQuantityOverrides },
    promoCodes: [...data.promoCodes],
    // Consents are restored on resume so a returning customer does not re-tick
    // what they already ticked (operator decision 2026-07-21). Both flows show
    // the same consents card, so this belongs to the shared intent.
    gdprConsent: data.gdprConsent,
    termsConsent: data.termsConsent,
    marketingConsent: data.marketingConsent,
    ...(isPersistedPromotionQuoteExpectation(data.checkoutQuoteExpectation)
      ? { checkoutQuoteExpectation: data.checkoutQuoteExpectation }
      : {}),
    ...(isPersistedPricingPolicyAssignment(data.pricingPolicyAssignment)
      ? { pricingPolicyAssignment: data.pricingPolicyAssignment }
      : {}),
  };

  if (scope.kind === "account") return common;
  return {
    ...common,
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    phone: data.phone,
    street: data.street,
    postalCode: data.postalCode,
    city: data.city,
    country: data.country,
    deliveryMethod: data.deliveryMethod,
    selectedPickupPoint: data.selectedPickupPoint,
    // Keep the id alive across a reload that happens before step 5 re-resolved it.
    ...(data.selectedDeliveryOption?.id ?? data.pendingDeliveryOptionId
      ? {
          selectedDeliveryOptionId:
            data.selectedDeliveryOption?.id ?? data.pendingDeliveryOptionId ?? undefined,
        }
      : {}),
  };
}

export function createConfiguratorDraftPersistedState(
  key: string,
): PersistedState<ConfiguratorDraftEnvelope> {
  const stored = createPersistedState<ConfiguratorDraftEnvelope>({
    key,
    version: CONFIGURATOR_DRAFT_VERSION,
    ttlMs: CONFIGURATOR_DRAFT_TTL_MS,
    sanitize: withConfiguratorStepIds,
    validate: isConfiguratorDraftEnvelope,
  });
  return {
    ...stored,
    load: () => {
      const data = stored.load();
      return data ? resolveConfiguratorDraftSteps(data) : null;
    },
    loadResult: () => {
      const result = stored.loadResult();
      return result.data
        ? { ...result, data: resolveConfiguratorDraftSteps(result.data) }
        : result;
    },
  };
}

export function migrateLegacyPublicDraft(
  destination: PersistedState<ConfiguratorDraftEnvelope>,
): ConfiguratorDraftEnvelope | null {
  const formStore = createPersistedState<ConfiguratorFormData>({
    key: LEGACY_FORM_KEY,
    version: 1,
    ttlMs: CONFIGURATOR_DRAFT_TTL_MS,
    validate: isLegacyConfiguratorForm,
  });
  const legacyForm = formStore.load();
  if (!legacyForm) return null;

  const stepStore = createPersistedState<number>({
    key: LEGACY_STEP_KEY,
    version: 1,
    ttlMs: CONFIGURATOR_DRAFT_TTL_MS,
    validate: Number.isInteger,
  });
  const maxStepStore = createPersistedState<number>({
    key: LEGACY_MAX_STEP_KEY,
    version: 1,
    ttlMs: CONFIGURATOR_DRAFT_TTL_MS,
    validate: Number.isInteger,
  });
  const step = Math.max(1, stepStore.load() ?? 1);
  const migrated: ConfiguratorDraftEnvelope = {
    form: serializeConfiguratorIntent(
      {
        ...legacyForm,
        lengthSelectionMode: legacyForm.lengthSelectionMode ?? "manual",
      },
      PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
    ),
    step,
    maxStep: Math.max(step, maxStepStore.load() ?? step),
  };
  // `destination.save` runs the dual-write, so the migrated v1 draft lands on
  // disk carrying `stepId`/`maxStepId` too. The in-memory value stays in the
  // plain `{ form, step, maxStep }` shape every other reader sees.
  const status = destination.save(migrated);
  if (status !== "saved" && status !== "unchanged") return migrated;
  formStore.clear();
  stepStore.clear();
  maxStepStore.clear();
  return migrated;
}

/**
 * ⛔ `stepId`/`maxStepId` are deliberately NOT checked here. An unrecognised id
 * (a newer bundle's step, a corrupted value) must never invalidate the whole
 * envelope — that would clear a customer's draft. It is ignored on read instead
 * and the numeric `step`/`maxStep` take over.
 */
function isConfiguratorDraftEnvelope(value: ConfiguratorDraftEnvelope): boolean {
  if (!value || typeof value !== "object") return false;
  return (
    Number.isInteger(value.step) &&
    Number.isInteger(value.maxStep) &&
    value.step >= 1 &&
    value.maxStep >= 1 &&
    isConfiguratorDraftIntent(value.form)
  );
}

function isConfiguratorDraftIntent(value: ConfiguratorDraftIntent): boolean {
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

function isLegacyConfiguratorForm(value: ConfiguratorFormData): boolean {
  return Boolean(
    value &&
      typeof value.dogName === "string" &&
      typeof value.lengthDays === "number" &&
      typeof value.subscription === "boolean" &&
      Array.isArray(value.allergens) &&
      Array.isArray(value.flavors) &&
      Array.isArray(value.promoCodes),
  );
}
