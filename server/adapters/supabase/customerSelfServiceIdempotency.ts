import type { SupabaseClient } from "@supabase/supabase-js";
import type { OperationalEventRecorder } from "../../_lib/observability/operationalEvents.js";
import { readAddresses, readOrdererProfiles } from "../../domains/customers/customerSelfServiceAddressModels.js";
import type { CustomerAddressReadStore } from "../../domains/customers/customerSelfServiceAddressModels.js";

const petSelect =
  "id, pet_type, name, breed, age_label, weight_kg, metadata, removed_at, removed_reason, created_at, updated_at";

export async function readPetByIdempotencyKey(client: SupabaseClient, clientId: string, idempotencyKey: string) {
  const { data, error } = await client
    .from("pets")
    .select(petSelect)
    .eq("client_id", clientId)
    .eq("metadata->>source", "customer_account")
    .eq("metadata->>idempotencyKey", idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function readOwnedPet(client: SupabaseClient, clientId: string, petId: string) {
  const { data, error } = await client
    .from("pets")
    .select(petSelect)
    .eq("id", petId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function hasRecordedEvent(
  client: SupabaseClient,
  clientId: string,
  eventType: string,
  idempotencyKey: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("customer_account_events")
    .select("id")
    .eq("client_id", clientId)
    .eq("event_type", eventType)
    .eq("payload->>idempotencyKey", idempotencyKey)
    .limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

export async function readCustomerAddressMutationResponse(store: CustomerAddressReadStore, clientId: string) {
  return {
    contractVersion: "customer.addresses.v1" as const,
    ordererProfiles: await readOrdererProfiles(store, clientId),
    addresses: await readAddresses(store, clientId),
  };
}

export async function runIdempotentCustomerMutation<T>({
  client,
  clientId,
  eventType,
  idempotencyKey,
  readReplay,
  mutate,
  operationalEvents,
}: {
  client: SupabaseClient;
  clientId: string;
  eventType: string;
  idempotencyKey: string;
  readReplay: () => Promise<T | null | undefined>;
  mutate: () => Promise<T>;
  operationalEvents?: OperationalEventRecorder;
}): Promise<T> {
  if (await hasRecordedEvent(client, clientId, eventType, idempotencyKey)) {
    const replayed = await readReplay();
    if (replayed != null) {
      operationalEvents?.({
        name: "customer_self_service_idempotency_replay",
        domain: "customers",
        surface: "customer",
        details: { eventType },
      });
      return replayed;
    }
  }
  return mutate();
}

export function mergePetMetadata(existing: unknown, patch: Record<string, unknown>) {
  const base = isRecord(existing) ? existing : {};
  return {
    ...base,
    ...patch,
    source: typeof base.source === "string" ? base.source : patch.source,
  };
}

export function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
