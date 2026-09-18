import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerSavedPaymentMethod } from "../../../src/domains/customers/contracts.js";
import {
  CUSTOMER_ADDRESSES_CONTRACT_VERSION,
} from "../../../src/domains/customers/contracts.js";
import {
  readAddresses,
  readOrdererProfiles,
} from "../../domains/customers/customerSelfServiceAddressModels.js";
import type {
  CustomerAddressBookPort,
  CustomerPaymentMethodsPort,
} from "../../domains/customers/ports.js";
import { createSupabaseCustomerAccountReadStore } from "./customerAccountReadStore.js";

export function createSupabaseCustomerAddressBookPort(
  client: SupabaseClient,
): CustomerAddressBookPort {
  const store = createSupabaseCustomerAccountReadStore(client);
  return {
    async getAddressBook(userId) {
      const clientId = await readClientId(client, userId);
      if (!clientId) return null;
      return {
        contractVersion: CUSTOMER_ADDRESSES_CONTRACT_VERSION,
        ordererProfiles: await readOrdererProfiles(store, clientId),
        addresses: await readAddresses(store, clientId),
      };
    },
  };
}

export function createSupabaseCustomerPaymentMethodsPort(
  customerClient: SupabaseClient,
  serviceClient: SupabaseClient,
): CustomerPaymentMethodsPort {
  return {
    async listPaymentMethods(userId): Promise<CustomerSavedPaymentMethod[] | null> {
      const clientId = await readClientId(customerClient, userId);
      if (!clientId) return null;

      const { data, error } = await serviceClient
        .from("commerce_payment_method_refs")
        .select("id,status,active,expires_at,updated_at,consent_snapshot,raw_provider_payload")
        .eq("client_id", clientId)
        .eq("provider_kind", "tpay")
        .eq("method_kind", "blik_payid")
        .eq("status", "active")
        .eq("active", true)
        .order("updated_at", { ascending: false })
        .limit(10);
      if (error) throw error;

      const now = Date.now();
      return (data ?? [])
        .filter((row) => !row.expires_at || Date.parse(row.expires_at) > now)
        .map((row) => {
          const aliasType = readAliasType(row) ?? "PAYID";
          return {
            id: row.id,
            provider: "tpay" as const,
            methodKind: "blik_payid" as const,
            status: "active" as const,
            usableFor: aliasType === "PAYID"
              ? ["one_time", "subscription"] as const
              : ["one_time"] as const,
            label: "BLIK w aplikacji bankowej",
          };
        });
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

function readAliasType(row: { raw_provider_payload?: unknown; consent_snapshot?: unknown }): "UID" | "PAYID" | null {
  const rawPayload = readRecord(row.raw_provider_payload);
  const consentSnapshot = readRecord(row.consent_snapshot);
  const candidates = [
    rawPayload?.aliasType,
    rawPayload?.["msg_value[type]"],
    consentSnapshot?.aliasType,
  ];
  for (const candidate of candidates) {
    if (candidate === "UID" || candidate === "PAYID") return candidate;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
