import type { SupabaseClient } from "@supabase/supabase-js";

interface PersonalizationLeadInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  country?: string | null;
}

// Service-role adapter for the early-lead mint. Calls the idempotent
// `personalization_persist_lead` RPC (resolve-or-create a lead client by exact
// lowercase email) and returns the resolved clientId. Used by the
// POST /api/bff/personalization/lead route so the /v2 hero identity cookie can be
// minted + the declension precomputed as soon as the visitor supplies their data
// at the configurator contact step — long before checkout.

interface LeadRpcRow {
  clientId?: unknown;
  matchReason?: unknown;
}

export function createSupabasePersonalizationLeadPort(
  client: SupabaseClient,
) {
  return {
    async persistLead(input: PersonalizationLeadInput) {
      const { data, error } = await client.rpc("personalization_persist_lead", {
        p_email: input.email,
        p_first_name: input.firstName ?? null,
        p_last_name: input.lastName ?? null,
        p_phone: input.phone ?? null,
        p_country: input.country ?? null,
      });
      if (error) throw new Error(`personalization_persist_lead RPC failed: ${error.message}`);

      const row = (data ?? {}) as LeadRpcRow;
      const clientId = typeof row.clientId === "string" ? row.clientId : null;
      if (!clientId) {
        throw new Error("personalization_persist_lead returned no clientId");
      }
      return {
        clientId,
        matchReason: typeof row.matchReason === "string" ? row.matchReason : "unknown",
      };
    },
  };
}
