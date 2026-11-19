import {
  CONFIGURATOR_SHIPPING_COUNTRY,
  type ConfiguratorIntent,
} from "@/domains/commerce/configuratorIntentContracts";
import type { ConfiguratorFormData } from "./configuratorFormStore";

type CheckoutProfile = Omit<ConfiguratorIntent["petProfile"], "dailyKcalOverride">;

export interface LegacyCheckoutIntentPolicy {
  readonly defaultLocale: ConfiguratorIntent["locale"];
  readonly shippingCountry: ConfiguratorIntent["address"]["country"];
  mapProfile(data: ConfiguratorFormData): CheckoutProfile | null;
}

/** Reference binding for the legacy configurator's form and wire contract. */
export const LEGACY_CHECKOUT_INTENT_POLICY: LegacyCheckoutIntentPolicy = {
  defaultLocale: "pl",
  shippingCountry: CONFIGURATOR_SHIPPING_COUNTRY,
  mapProfile(data) {
    const weightKg = Number(data.dogWeightKg.replace(",", ".").trim());
    if (!Number.isFinite(weightKg) || weightKg <= 0) return null;

    return {
      petId: data.accountPetId,
      name: data.dogName.trim(),
      ageBand: data.dogAge as CheckoutProfile["ageBand"],
      breed: data.dogBreed.trim(),
      weightKg,
      activityLevel: data.activityLevel as CheckoutProfile["activityLevel"],
      bcs: data.bcs as CheckoutProfile["bcs"],
      allergenSlugs: data.hasAllergies ? data.allergens : [],
    };
  },
};
