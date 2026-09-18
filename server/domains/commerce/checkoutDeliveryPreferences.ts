import type { CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";

export type CheckoutDeliveryPreferenceScope = "one_time" | "subscription" | "any";

export interface CheckoutDeliveryPreferenceUpsert {
  clientId: string;
  scope: CheckoutDeliveryPreferenceScope;
  deliveryKind: "courier" | "parcel-locker";
  providerKind: "omnipack" | "dhl" | "manual" | "simulator";
  carrierKind: string;
  carrierCode: string;
  serviceCode: string;
  pickupPoint: {
    id: string;
    name: string;
    address: {
      line1: string;
      postalCode: string;
      city: string;
      country: string;
    } | null;
  } | null;
}

export interface CheckoutDeliveryPreferenceStore {
  upsertDeliveryPreference(input: CheckoutDeliveryPreferenceUpsert): Promise<void>;
}

export function checkoutDeliveryPreferenceInputs(input: {
  clientId: string;
  checkoutKind: CheckoutKind;
  selectedDelivery: ConfiguratorIntent["selectedDelivery"] | null | undefined;
}): CheckoutDeliveryPreferenceUpsert[] {
  const delivery = input.selectedDelivery;
  if (!delivery?.providerKind || !delivery.carrierKind || !delivery.carrierCode || !delivery.serviceCode) {
    return [];
  }

  const deliveryKind = delivery.deliveryKind ?? delivery.kind;
  const pickupPoint = deliveryKind === "parcel-locker" ? delivery.pickupPoint ?? null : null;
  if (deliveryKind === "parcel-locker" && !pickupPoint) return [];

  const base: Omit<CheckoutDeliveryPreferenceUpsert, "scope"> = {
    clientId: input.clientId,
    deliveryKind,
    providerKind: delivery.providerKind,
    carrierKind: delivery.carrierKind,
    carrierCode: delivery.carrierCode,
    serviceCode: delivery.serviceCode,
    pickupPoint: pickupPoint
      ? {
          id: pickupPoint.id,
          name: pickupPoint.name,
          address: pickupPoint.address,
        }
      : null,
  };
  const scoped: CheckoutDeliveryPreferenceScope =
    input.checkoutKind === "subscription_initial" ? "subscription" : "one_time";

  return [
    { ...base, scope: scoped },
    { ...base, scope: "any" },
  ];
}

export async function upsertCheckoutDeliveryPreferencesBestEffort(input: {
  store: CheckoutDeliveryPreferenceStore | undefined;
  clientId: string;
  checkoutKind: CheckoutKind;
  selectedDelivery: ConfiguratorIntent["selectedDelivery"] | null | undefined;
}): Promise<void> {
  if (!input.store) return;
  const preferences = checkoutDeliveryPreferenceInputs({
    clientId: input.clientId,
    checkoutKind: input.checkoutKind,
    selectedDelivery: input.selectedDelivery,
  });
  for (const preference of preferences) {
    try {
      await input.store.upsertDeliveryPreference(preference);
    } catch (error) {
      console.warn(
        "checkout_delivery_preference_upsert_failed",
        JSON.stringify({
          clientId: input.clientId,
          scope: preference.scope,
          reason: safeCommerceDiagnosticValue(error instanceof Error ? error.message : String(error)),
        }),
      );
      return;
    }
  }
}
