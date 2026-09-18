// Shared `clients` table → email-recipient resolver used by the subscription
// lifecycle and dunning recipient ports. Both ports read the identical
// columns/shape; only their error-prefix and their (structurally identical)
// port type differ, so the resolve body lives here once and each domain port
// stays a thin typed wrapper (see subscriptionRecipient.ts /
// subscriptionDunningRecipient.ts).

import type {
  ClientsRecipient,
  ClientsRecipientPort,
} from "../../../domains/subscription/subscriberRetention.js";

export interface ClientsRecipientSupabaseClient {
  from(table: string): ClientsRecipientQueryBuilder;
}

interface ClientsRecipientQueryBuilder {
  select(columns: string): ClientsRecipientQueryBuilder;
  eq(column: string, value: unknown): ClientsRecipientQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export function createClientsRecipientPort(
  client: ClientsRecipientSupabaseClient,
  options: { errorPrefix: string },
): ClientsRecipientPort {
  return {
    // The signal is accepted per the port contract but not wired into the query:
    // the repo's supabase usage never passes abortSignal; the worker-side timeout
    // is the backstop for a hung query.
    async resolve(clientId: string, _signal: AbortSignal): Promise<ClientsRecipient | null> {
      const result = await client
        .from("clients")
        .select("email, first_name, country")
        .eq("id", clientId)
        .maybeSingle();
      if (result.error) {
        throw new Error(
          `${options.errorPrefix}: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      const row = result.data as {
        email?: string | null;
        first_name?: string | null;
        country?: string | null;
      } | null;
      if (!row || typeof row.email !== "string" || row.email === "") return null;

      return {
        email: row.email,
        firstName:
          typeof row.first_name === "string" && row.first_name !== "" ? row.first_name : null,
        country: typeof row.country === "string" && row.country !== "" ? row.country : null,
      };
    },
  };
}
