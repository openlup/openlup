import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerDeliveryPreference,
  CustomerDeliveryPreferenceUpsertRequest,
  CustomerPaymentPreference,
  CustomerPaymentPreferenceUpsertRequest,
} from "../../../src/domains/customers/contracts.js";
import type {
  CustomerDeliveryPreferencesPort,
  CustomerPaymentPreferencesPort,
} from "../../domains/customers/ports.js";

type PickupAddress = NonNullable<NonNullable<CustomerDeliveryPreference["pickupPoint"]>["address"]>;

interface PaymentPreferenceRow {
  scope: CustomerPaymentPreference["scope"];
  method_kind: CustomerPaymentPreference["methodKind"];
  last_selected_at: string;
}

interface DeliveryPreferenceRow {
  scope: CustomerDeliveryPreference["scope"];
  delivery_kind: CustomerDeliveryPreference["deliveryKind"];
  provider_kind: CustomerDeliveryPreference["providerKind"];
  carrier_kind: string;
  carrier_code: string;
  service_code: string;
  pickup_point_id: string | null;
  pickup_point_name: string | null;
  pickup_point_address: PickupAddress | null;
  last_selected_at: string;
}

const DELIVERY_COLUMNS =
  "scope, delivery_kind, provider_kind, carrier_kind, carrier_code, service_code, pickup_point_id, pickup_point_name, pickup_point_address, last_selected_at";

export function createSupabaseCustomerPaymentPreferencesPort(
  client: SupabaseClient,
): CustomerPaymentPreferencesPort {
  return {
    async listPaymentPreferences(userId): Promise<CustomerPaymentPreference[] | null> {
      const clientId = await readClientId(client, userId);
      if (!clientId) return null;

      const { data, error } = await client
        .from("customer_payment_preferences")
        .select("scope, method_kind, last_selected_at")
        .eq("client_id", clientId)
        .order("last_selected_at", { ascending: false });
      if (error) throw error;

      return ((data ?? []) as PaymentPreferenceRow[]).map(mapPaymentPreferenceRow);
    },

    async upsertPaymentPreference(
      userId,
      input: CustomerPaymentPreferenceUpsertRequest,
    ): Promise<CustomerPaymentPreference | null> {
      const clientId = await readClientId(client, userId);
      if (!clientId) return null;

      const selectedAt = new Date().toISOString();
      const row = {
        client_id: clientId,
        scope: input.scope,
        method_kind: input.methodKind,
        last_selected_at: selectedAt,
        updated_at: selectedAt,
      };

      const { data, error } = await client
        .from("customer_payment_preferences")
        .upsert(row, { onConflict: "client_id,scope" })
        .select("scope, method_kind, last_selected_at")
        .single();
      if (error) throw error;

      return mapPaymentPreferenceRow(data as PaymentPreferenceRow);
    },
  };
}

export function createSupabaseCustomerDeliveryPreferencesPort(
  client: SupabaseClient,
): CustomerDeliveryPreferencesPort {
  return {
    async listDeliveryPreferences(userId): Promise<CustomerDeliveryPreference[] | null> {
      const clientId = await readClientId(client, userId);
      if (!clientId) return null;

      const { data, error } = await client
        .from("customer_delivery_preferences")
        .select(DELIVERY_COLUMNS)
        .eq("client_id", clientId)
        .order("last_selected_at", { ascending: false });
      if (error) throw error;

      return ((data ?? []) as DeliveryPreferenceRow[]).map(mapDeliveryPreferenceRow);
    },

    async upsertDeliveryPreference(
      userId,
      input: CustomerDeliveryPreferenceUpsertRequest,
    ): Promise<CustomerDeliveryPreference | null> {
      const clientId = await readClientId(client, userId);
      if (!clientId) return null;

      const selectedAt = new Date().toISOString();
      const row = {
        client_id: clientId,
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
        updated_at: selectedAt,
      };

      const { data, error } = await client
        .from("customer_delivery_preferences")
        .upsert(row, { onConflict: "client_id,scope" })
        .select(DELIVERY_COLUMNS)
        .single();
      if (error) throw error;

      return mapDeliveryPreferenceRow(data as DeliveryPreferenceRow);
    },
  };
}

async function readClientId(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client
    .from("clients")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.id === "string" ? data.id : null;
}

function mapPaymentPreferenceRow(row: PaymentPreferenceRow): CustomerPaymentPreference {
  return {
    scope: row.scope,
    methodKind: row.method_kind,
    lastSelectedAt: row.last_selected_at,
  };
}

function mapDeliveryPreferenceRow(row: DeliveryPreferenceRow): CustomerDeliveryPreference {
  return {
    scope: row.scope,
    deliveryKind: row.delivery_kind,
    providerKind: row.provider_kind,
    carrierKind: row.carrier_kind,
    carrierCode: row.carrier_code,
    serviceCode: row.service_code,
    pickupPoint: row.pickup_point_id
      ? {
          id: row.pickup_point_id,
          name: row.pickup_point_name ?? row.pickup_point_id,
          address: row.pickup_point_address ?? null,
        }
      : null,
    lastSelectedAt: row.last_selected_at,
  };
}
