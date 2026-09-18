import type { SupabaseClient } from "@supabase/supabase-js";

type CaseForms = Record<
  | "nominative"
  | "genitive"
  | "dative"
  | "accusative"
  | "instrumental"
  | "locative"
  | "vocative",
  string
>;

// Service-role reads for the /v2 hero endpoint. All reads are keyed by clientId
// (resolved from the signed cookie or the authenticated uid), so this bypasses RLS
// intentionally and only ever returns the one caller's own data.

interface RowShape {
  dog_cases: CaseForms | null;
  dog_conf: "high" | "low" | null;
}

const PAID_STATUSES = ["paid", "fulfillment_pending", "fulfilled"] as const;

export function createSupabasePersonalizationReadPort(
  client: SupabaseClient,
) {
  return {
    async resolveClientIdByAuthUser(authUserId: string): Promise<string | null> {
      const { data, error } = await client
        .from("clients")
        .select("id")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (error) throw error;
      return typeof (data as { id?: string } | null)?.id === "string"
        ? (data as { id: string }).id
        : null;
    },

    async loadRow(clientId: string) {
      // Subject-led hero: only the selected forms are read. Owner forms stay written (for
      // future email use) but are never fetched into the /v2 read path.
      const { data, error } = await client
        .from("customer_personalization")
        .select("dog_cases, dog_conf")
        .eq("client_id", clientId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const row = data as RowShape;
      return {
        dogCases: row.dog_cases ?? null,
        dogConf: row.dog_conf ?? null,
      };
    },

    async hasPaidOrder(clientId: string): Promise<boolean> {
      const { data, error } = await client
        .from("commerce_orders")
        .select("id")
        .eq("client_id", clientId)
        .in("status", PAID_STATUSES as unknown as string[])
        .limit(1);
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },

    /**
     * Count the caller's eligible subjects. Drives the logged-in pack variant.
     * Only queried on the JWT path; a failure/absence
     * degrades to 0 → single-dog copy.
     */
    async countDogs(clientId: string): Promise<number> {
      const { count, error } = await client
        .from("pets")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("pet_type", "dog");
      if (error) throw error;
      return typeof count === "number" ? count : 0;
    },
  };
}
