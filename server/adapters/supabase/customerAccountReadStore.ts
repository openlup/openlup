import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerAccountReadRow,
  CustomerAccountReadStore,
} from "../../domains/customers/customerSelfServiceReadModels.js";
import type { CustomerAddressReadStore } from "../../domains/customers/customerSelfServiceAddressModels.js";

export type CustomerAccountStore = CustomerAccountReadStore & CustomerAddressReadStore;

const PET_COLUMNS =
  "id, pet_type, name, breed, age_label, weight_kg, metadata, removed_at, created_at, updated_at";
const SUBSCRIPTION_COLUMNS =
  "id, pet_id, status, cadence_days, next_cycle_at, edit_window_hours, payment_method_kind, template_version, size_constraint";
const DELIVERY_COLUMNS =
  "scope, delivery_kind, provider_kind, carrier_kind, carrier_code, service_code, pickup_point_id, pickup_point_name, pickup_point_address, last_selected_at";
const ADDRESS_COLUMNS =
  "id, kind, label, recipient_name, contact_phone, company_name, tax_id, line1, line2, city, postal_code, country, is_default, delivery_notes, courier_instructions, last_used_at, created_at, updated_at";
const ORDERER_COLUMNS =
  "id, label, full_name, email, phone, company_name, tax_id, company_verification_level, company_identity_source, company_identity_evidence_hash, is_default, created_at, updated_at";

/** Managed persistence for customer account read-model rows. Mapping stays in the domain. */
export function createSupabaseCustomerAccountReadStore(client: SupabaseClient): CustomerAccountStore {
  return {
    async readPets(clientId) {
      return readMany(
        client.from("pets").select(PET_COLUMNS).eq("client_id", clientId).order("created_at", { ascending: true }),
      );
    },
    async readSubscriptions(clientId) {
      return readMany(
        client.from("subscriptions").select(SUBSCRIPTION_COLUMNS).eq("client_id", clientId).order("created_at", { ascending: false }),
      );
    },
    async readSubscriptionLines(subscriptionIds) {
      if (subscriptionIds.length === 0) return [];
      return readMany(
        client.from("subscription_lines")
          .select("id, subscription_id, variant_id, qty, sort_order, is_addon")
          .in("subscription_id", subscriptionIds)
          .order("sort_order", { ascending: true }),
      );
    },
    async readPaymentPreferences(clientId) {
      return readMany(
        client.from("customer_payment_preferences")
          .select("scope, method_kind, last_selected_at")
          .eq("client_id", clientId)
          .order("last_selected_at", { ascending: false }),
      );
    },
    async readDeliveryPreferences(clientId) {
      return readMany(
        client.from("customer_delivery_preferences")
          .select(DELIVERY_COLUMNS)
          .eq("client_id", clientId)
          .order("last_selected_at", { ascending: false }),
      );
    },
    async readEvents(clientId) {
      return readMany(
        client.from("customer_account_events")
          .select("id, event_type, entity_type, entity_id, occurred_at")
          .eq("client_id", clientId)
          .order("occurred_at", { ascending: false })
          .limit(20),
      );
    },
    async recordEvent(input) {
      const { error } = await client.from("customer_account_events").insert({
        client_id: input.clientId,
        event_type: input.eventType,
        entity_type: input.entityType,
        entity_id: input.entityId,
        payload: input.payload,
      });
      if (error) throw error;
    },
    async petHasActiveSubscription(clientId, petId) {
      const rows = await readMany(
        client.from("subscriptions")
          .select("id")
          .eq("client_id", clientId)
          .eq("pet_id", petId)
          .in("status", ["active", "paused"])
          .limit(1),
      );
      return rows.length > 0;
    },
    async readAddresses(clientId) {
      return readMany(
        client.from("addresses")
          .select(ADDRESS_COLUMNS)
          .eq("client_id", clientId)
          .order("is_default", { ascending: false })
          .order("updated_at", { ascending: false }),
      );
    },
    async readOrdererProfiles(clientId) {
      return readMany(
        client.from("customer_orderer_profiles")
          .select(ORDERER_COLUMNS)
          .eq("client_id", clientId)
          .order("is_default", { ascending: false })
          .order("updated_at", { ascending: false }),
      );
    },
    async addressUsedByActiveSubscription(clientId, addressId) {
      const rows = await readMany(
        client.from("subscriptions")
          .select("id")
          .eq("client_id", clientId)
          .or(`shipping_address_id.eq.${addressId},billing_address_id.eq.${addressId}`)
          .in("status", ["active", "paused"])
          .limit(1),
      );
      return rows.length > 0;
    },
    async findCanonicalAddressId(clientId, canonicalKey) {
      const { data, error } = await client.from("addresses")
        .select("id")
        .eq("client_id", clientId)
        .eq("canonical_key", canonicalKey)
        .order("last_used_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return typeof data?.id === "string" ? data.id : null;
    },
    async clearDefaultAddress(clientId, kind, updatedAt) {
      const { error } = await client.from("addresses")
        .update({ is_default: false, updated_at: updatedAt })
        .eq("client_id", clientId)
        .eq("kind", kind);
      if (error) throw error;
    },
  };
}

async function readMany(
  query: PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<CustomerAccountReadRow[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CustomerAccountReadRow[];
}
