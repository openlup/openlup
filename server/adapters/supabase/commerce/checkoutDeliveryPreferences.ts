import type {
  CheckoutDeliveryPreferenceStore,
  CheckoutDeliveryPreferenceUpsert,
} from "../../../domains/commerce/checkoutDeliveryPreferences.js";

interface SupabaseDeliveryPreferenceClient {
  from(table: "customer_delivery_preferences"): {
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string },
    ): {
      select(columns: string): {
        single(): Promise<{ error: { message?: string } | null }>;
      };
    };
  };
}

export function createSupabaseCheckoutDeliveryPreferenceStore(
  client: SupabaseDeliveryPreferenceClient,
): CheckoutDeliveryPreferenceStore {
  return {
    async upsertDeliveryPreference(input) {
      const selectedAt = new Date().toISOString();
      const { error } = await client
        .from("customer_delivery_preferences")
        .upsert(toRow(input, selectedAt), { onConflict: "client_id,scope" })
        .select("id")
        .single();
      if (error) throw new Error(error.message ?? "checkout_delivery_preference_upsert_failed");
    },
  };
}

function toRow(input: CheckoutDeliveryPreferenceUpsert, selectedAt: string): Record<string, unknown> {
  return {
    client_id: input.clientId,
    scope: input.scope,
    delivery_kind: input.deliveryKind,
    provider_kind: input.providerKind,
    carrier_kind: input.carrierKind,
    carrier_code: input.carrierCode,
    service_code: input.serviceCode,
    pickup_point_id: input.pickupPoint?.id ?? null,
    pickup_point_name: input.pickupPoint?.name ?? null,
    pickup_point_address: input.pickupPoint?.address ?? null,
    last_selected_at: selectedAt,
    source: "checkout",
    updated_at: selectedAt,
  };
}
