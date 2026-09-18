import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
  commerceCustomerDefaultsSnapshotSchema,
  type CommerceCustomerDefaultsSnapshot,
} from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import type {
  CommerceCustomerDefaultsReadPort,
} from "../../../src/domains/commerce/ports.js";
import type { CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";

interface PreferenceRow {
  scope: "one_time" | "subscription" | "any";
  method_kind: "blik" | "card" | "transfer";
  last_selected_at: string;
}

interface AddressHintRow {
  id: string;
  kind: "shipping" | "billing" | "both";
  is_default: boolean;
  updated_at: string;
}

interface OrdererHintRow {
  id: string;
  is_default: boolean;
  updated_at: string;
}

export function createSupabaseCustomerDefaultsSnapshotPort(
  client: SupabaseClient,
): CommerceCustomerDefaultsReadPort {
  return {
    async getCustomerDefaultsSnapshot({ clientId, checkoutKind }) {
      const [preferences, addresses, orderers] = await Promise.all([
        readPreferences(client, clientId),
        readAddressHints(client, clientId),
        readOrdererHints(client, clientId),
      ]);

      return buildSnapshot({ clientId, checkoutKind, preferences, addresses, orderers });
    },
  };
}

async function readPreferences(
  client: SupabaseClient,
  clientId: string,
): Promise<PreferenceRow[]> {
  const { data, error } = await client
    .from("customer_payment_preferences")
    .select("scope, method_kind, last_selected_at")
    .eq("client_id", clientId)
    .order("last_selected_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PreferenceRow[];
}

async function readAddressHints(
  client: SupabaseClient,
  clientId: string,
): Promise<AddressHintRow[]> {
  const { data, error } = await client
    .from("addresses")
    .select("id, kind, is_default, updated_at")
    .eq("client_id", clientId)
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AddressHintRow[];
}

async function readOrdererHints(
  client: SupabaseClient,
  clientId: string,
): Promise<OrdererHintRow[]> {
  const { data, error } = await client
    .from("customer_orderer_profiles")
    .select("id, is_default, updated_at")
    .eq("client_id", clientId)
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as OrdererHintRow[];
}

function buildSnapshot(input: {
  clientId: string;
  checkoutKind: CheckoutKind;
  preferences: PreferenceRow[];
  addresses: AddressHintRow[];
  orderers: OrdererHintRow[];
}): CommerceCustomerDefaultsSnapshot {
  const payment = pickPaymentPreference(input.preferences, input.checkoutKind);
  const shipping = pickDefaultAddress(input.addresses, "shipping");
  const billing = pickDefaultAddress(input.addresses, "billing");
  const orderer = input.orderers.find((row) => row.is_default) ?? input.orderers[0] ?? null;
  const redactedFields = [
    "contact",
    "orderer_profile",
    "shipping_address",
    "billing_address",
    "delivery_notes",
    "courier_instructions",
    "payment_provider",
    "payment_secret",
  ].filter(Boolean);

  return commerceCustomerDefaultsSnapshotSchema.parse({
    version: CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
    clientId: input.clientId,
    payment: {
      available: Boolean(payment),
      scope: payment?.scope ?? null,
      methodKind: payment?.method_kind ?? null,
      source: "customer_payment_preferences",
      applied: false,
    },
    addresses: {
      hasDefaultShippingAddress: Boolean(shipping),
      defaultShippingAddressId: shipping?.id ?? null,
      hasDefaultBillingAddress: Boolean(billing),
      defaultBillingAddressId: billing?.id ?? null,
      hasDefaultOrdererProfile: Boolean(orderer),
      defaultOrdererProfileId: orderer?.id ?? null,
      hasDeliveryNotes: false,
      hasCourierInstructions: false,
      source: "customer_address_profiles",
      applied: false,
    },
    redactedFields,
  });
}

function pickPaymentPreference(
  preferences: PreferenceRow[],
  checkoutKind: CheckoutKind,
): PreferenceRow | null {
  const scope = checkoutKind === "subscription_initial" ? "subscription" : "one_time";
  return preferences.find((row) => row.scope === scope) ??
    preferences.find((row) => row.scope === "any") ??
    null;
}

function pickDefaultAddress(
  rows: AddressHintRow[],
  kind: "shipping" | "billing",
): AddressHintRow | null {
  return rows.find((row) => row.is_default && (row.kind === kind || row.kind === "both")) ??
    rows.find((row) => row.kind === kind || row.kind === "both") ??
    null;
}
