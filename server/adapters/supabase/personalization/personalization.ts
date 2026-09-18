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

interface WritePersonalizationInput {
  clientId: string;
  ownerNameRaw: string | null;
  ownerCases: CaseForms | null;
  ownerConf: "high" | "low";
  primaryPetId: string | null;
  dogNameRaw: string | null;
  dogCases: CaseForms | null;
  dogGender: "masculine" | "feminine" | "neuter" | "unknown" | null;
  dogConf: "high" | "low";
  source: "dictionary" | "llm";
  modelVersion: string;
  inputHash: string;
}

// Service-role Supabase adapter for personalization reads/writes + enqueue.
// Writes are service-role only (RLS on customer_personalization is admin/own-row
// SELECT). Enqueue is an idempotent upsert on the outbox unique key so a repeated
// persist of the same names never doubles the job.

interface ClientNameRow {
  first_name: string | null;
}
interface DogPetRow {
  id: string;
  name: string | null;
}
interface InputHashRow {
  input_hash: string | null;
}

export function createSupabasePersonalizationPort(
  client: SupabaseClient,
) {
  return {
    async loadNames(clientId: string) {
      const { data: clientRow, error: clientErr } = await client
        .from("clients")
        .select("first_name")
        .eq("id", clientId)
        .maybeSingle();
      if (clientErr) throw clientErr;
      if (!clientRow) return null;

      const { data: petRow, error: petErr } = await client
        .from("pets")
        .select("id, name")
        .eq("client_id", clientId)
        .eq("pet_type", "dog")
        // "Freshest" is the most recently added eligible subject record.
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (petErr) throw petErr;

      const pet = petRow as DogPetRow | null;
      return {
        clientId,
        ownerName: (clientRow as ClientNameRow).first_name ?? null,
        dogName: pet?.name ?? null,
        primaryPetId: pet?.id ?? null,
      };
    },

    async writePersonalization(input: WritePersonalizationInput): Promise<void> {
      const now = new Date().toISOString();
      const { error } = await client.from("customer_personalization").upsert(
        {
          client_id: input.clientId,
          owner_name_raw: input.ownerNameRaw,
          owner_cases: input.ownerCases,
          owner_conf: input.ownerConf,
          primary_pet_id: input.primaryPetId,
          dog_name_raw: input.dogNameRaw,
          dog_gender: input.dogGender,
          dog_cases: input.dogCases,
          dog_conf: input.dogConf,
          source: input.source,
          model_version: input.modelVersion,
          input_hash: input.inputHash,
          generated_at: now,
          updated_at: now,
        },
        { onConflict: "client_id" },
      );
      if (error) throw error;
    },

    async readInputHash(clientId: string): Promise<string | null> {
      const { data, error } = await client
        .from("customer_personalization")
        .select("input_hash")
        .eq("client_id", clientId)
        .maybeSingle();
      if (error) throw error;
      return (data as InputHashRow | null)?.input_hash ?? null;
    },

    async enqueueDeclension({
      clientId,
      inputHash,
    }: { clientId: string; inputHash: string }): Promise<void> {
      // Enqueue lives in SQL (single guarded outbox producer), not a TS insert.
      const { error } = await client.rpc("personalization_enqueue_declension", {
        p_client_id: clientId,
        p_input_hash: inputHash,
      });
      if (error) throw error;
    },
  };
}
