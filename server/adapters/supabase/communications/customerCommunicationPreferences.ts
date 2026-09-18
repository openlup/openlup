import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_COMMUNICATION_PREFERENCES_CONTRACT_VERSION,
  type CustomerCommunicationPreferencesResponse,
} from "../../../../src/domains/communications/customerPreferencesContracts.js";
import type { CustomerCommunicationPreferencesPort } from "../../../domains/communications/customerCommunicationPreferencesHandler.js";

interface SupabaseCustomerCommunicationPreferencesDeps {
  customerClient: SupabaseClient;
  serviceClient: SupabaseClient;
}

interface ClientRow {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

interface ContactRow {
  id: string;
  normalized_email: string;
}

interface PermissionRow {
  state: "unknown" | "granted" | "denied" | "suppressed";
  source: string | null;
  reason: string | null;
  captured_at: string | null;
  updated_at: string | null;
}

export function createSupabaseCustomerCommunicationPreferencesPort({
  customerClient,
  serviceClient,
}: SupabaseCustomerCommunicationPreferencesDeps): CustomerCommunicationPreferencesPort {
  return {
    async getPreferences(userId) {
      const client = await readLinkedClient(customerClient, userId);
      if (!client || !client.email) return null;
      return readPreferences(serviceClient, client.email);
    },

    async updatePreferences(userId, input) {
      const client = await readLinkedClient(customerClient, userId);
      if (!client || !client.email) return null;

      const contactId = await touchAndLinkContact(serviceClient, client);
      await recordNewsletterPreference(serviceClient, contactId, client, input.marketingNewsletterConsent);
      return readPreferences(serviceClient, client.email);
    },
  };
}

async function readLinkedClient(client: SupabaseClient, userId: string): Promise<ClientRow | null> {
  const { data, error } = await client
    .from("clients")
    .select("id, email, first_name, last_name")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as ClientRow | null;
}

async function readPreferences(
  client: SupabaseClient,
  email: string,
): Promise<CustomerCommunicationPreferencesResponse> {
  const normalizedEmail = normalizeEmail(email);
  const { data: contact, error: contactError } = await table(client, "communication_contacts")
    .select("id, normalized_email")
    .eq("normalized_email", normalizedEmail)
    .maybeSingle();
  if (contactError) throw contactError;

  if (!contact) {
    return response(null, null, normalizedEmail);
  }

  const contactRow = contact as ContactRow;
  const { data: permission, error: permissionError } = await table(client, "communication_permissions")
    .select("state, source, reason, captured_at, updated_at")
    .eq("contact_id", contactRow.id)
    .eq("purpose", "marketing_newsletter")
    .maybeSingle();
  if (permissionError) throw permissionError;

  return response(contactRow, permission as PermissionRow | null, normalizedEmail);
}

async function touchAndLinkContact(client: SupabaseClient, row: ClientRow): Promise<string> {
  const contact = await rpc(client, "communication_touch_contact", {
    p_email: row.email,
    p_first_name: row.first_name,
    p_last_name: row.last_name,
    p_status: "active",
    p_metadata: { source: "customer_communication_preferences" },
  });
  if (contact.error || typeof contact.data !== "string") {
    throw contact.error ?? new Error("communication_touch_contact_failed");
  }

  const link = await rpc(client, "communication_link_contact", {
    p_contact_id: contact.data,
    p_source_table: "clients",
    p_source_id: row.id,
    p_source_key: row.email,
    p_metadata: {
      source: "customer_communication_preferences",
      actorType: "customer_self_service",
    },
  });
  if (link.error) throw link.error;

  return contact.data;
}

async function recordNewsletterPreference(
  client: SupabaseClient,
  contactId: string,
  row: ClientRow,
  consent: boolean,
) {
  const event = await rpc(client, "communication_record_permission_event", {
    p_contact_id: contactId,
    p_purpose: "marketing_newsletter",
    p_state: consent ? "granted" : "denied",
    p_source: "customer_communication_preferences",
    p_source_ref: {
      route: "/api/bff/customers/communication-preferences",
      clientId: row.id,
    },
    p_reason: consent ? "customer_self_service_grant" : "customer_self_service_denial",
    p_metadata: {
      actorType: "customer_self_service",
      captureMethod: "customer_account",
      consentCopyVersion: "customer_account_marketing_newsletter.v1",
    },
    p_captured_at: new Date().toISOString(),
    p_create_sync_event: true,
  });
  if (event.error) throw event.error;
}

function response(
  contact: ContactRow | null,
  permission: PermissionRow | null,
  email: string,
): CustomerCommunicationPreferencesResponse {
  const state = permission?.state ?? "unknown";
  return {
    contractVersion: CUSTOMER_COMMUNICATION_PREFERENCES_CONTRACT_VERSION,
    contact: contact ? { contactId: contact.id, email } : null,
    marketingNewsletter: {
      purpose: "marketing_newsletter",
      state,
      granted: state === "granted",
      source: permission?.source ?? null,
      reason: permission?.reason ?? null,
      capturedAt: permission?.captured_at ?? null,
      updatedAt: permission?.updated_at ?? null,
    },
  };
}

function table(client: SupabaseClient, name: string) {
  return client.from(name as never) as unknown as {
    select: (columns: string) => {
      eq: (field: string, value: string) => {
        eq: (field: string, value: string) => {
          maybeSingle: () => Promise<{ data?: unknown; error?: unknown }>;
        };
        maybeSingle: () => Promise<{ data?: unknown; error?: unknown }>;
      };
    };
  };
}

function rpc(client: SupabaseClient, name: string, params: Record<string, unknown>) {
  return (client as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error?: unknown }>;
  }).rpc(name, params);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
