import type {
  CustomerAccountResponse,
  CustomerPetCreateRequest,
  CustomerPetMutationResponse,
  CustomerPetsResponse,
  CustomerPetUpdateRequest,
} from "../../../src/domains/customers/selfServiceContracts.js";
import { CUSTOMER_SELF_SERVICE_CONTRACT_VERSION } from "../../../src/domains/customers/selfServiceContracts.js";
import type { CustomerDeliveryPreference, CustomerPaymentPreference } from "../../../src/domains/customers/contracts.js";

export type CustomerAccountReadRow = Record<string, unknown>;
type Row = CustomerAccountReadRow;

export interface CustomerAccountReadStore {
  readPets(clientId: string): Promise<Row[]>;
  readSubscriptions(clientId: string): Promise<Row[]>;
  readSubscriptionLines(subscriptionIds: string[]): Promise<Row[]>;
  readPaymentPreferences(clientId: string): Promise<Row[]>;
  readDeliveryPreferences(clientId: string): Promise<Row[]>;
  readEvents(clientId: string): Promise<Row[]>;
  recordEvent(input: {
    clientId: string;
    eventType: string;
    entityType: string;
    entityId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void>;
  petHasActiveSubscription(clientId: string, petId: string): Promise<boolean>;
}

export async function readPets(store: CustomerAccountReadStore, clientId: string): Promise<CustomerPetsResponse["pets"]> {
  return (await store.readPets(clientId)).map(mapPet);
}

export function petResponse(row: Row): CustomerPetMutationResponse {
  return { contractVersion: CUSTOMER_SELF_SERVICE_CONTRACT_VERSION, pet: mapPet(row) };
}

export function petMetadata(input: CustomerPetCreateRequest | CustomerPetUpdateRequest) {
  const isCreate = "petType" in input;
  return compact({
    activityLevel: input.activityLevel,
    bodyCondition: input.bodyCondition,
    allergies: input.allergies ?? (isCreate ? [] : undefined),
    photoUrl: input.photoUrl,
    source: "customer_account",
    idempotencyKey: input.idempotencyKey,
  });
}

export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function mapPet(row: Row): CustomerPetsResponse["pets"][number] {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return {
    petId: text(row.id),
    petType: text(row.pet_type) as CustomerPetsResponse["pets"][number]["petType"],
    name: nullableText(row.name),
    breed: nullableText(row.breed),
    ageLabel: nullableText(row.age_label),
    weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
    activityLevel: typeof metadata.activityLevel === "string" ? metadata.activityLevel : null,
    bodyCondition: typeof metadata.bodyCondition === "string" ? metadata.bodyCondition : null,
    allergies: Array.isArray(metadata.allergies) ? metadata.allergies.filter((v: unknown) => typeof v === "string") : [],
    photoUrl: typeof metadata.photoUrl === "string" ? metadata.photoUrl : null,
    removedAt: nullableText(row.removed_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export async function readSubscriptions(
  store: CustomerAccountReadStore,
  clientId: string,
): Promise<CustomerAccountResponse["subscriptions"]> {
  const rows = await store.readSubscriptions(clientId);
  const ids = rows.map((row) => text(row.id));
  const lineMap = await readSubscriptionLines(store, ids);
  return rows.map((row) => ({
    subscriptionId: text(row.id),
    petId: nullableText(row.pet_id),
    status: text(row.status) as CustomerAccountResponse["subscriptions"][number]["status"],
    cadenceDays: Number(row.cadence_days),
    nextCycleAt: nullableText(row.next_cycle_at),
    editCutoffAt: editCutoff(nullableText(row.next_cycle_at), numberOrNull(row.edit_window_hours)),
    paymentMethodKind: nullableText(row.payment_method_kind),
    templateVersion: Number(row.template_version),
    sizeConstraint: isRecord(row.size_constraint) ? row.size_constraint : null,
    lines: lineMap.get(text(row.id)) ?? [],
  }));
}

export async function readPaymentPreferences(
  store: CustomerAccountReadStore,
  clientId: string,
): Promise<CustomerPaymentPreference[]> {
  return (await store.readPaymentPreferences(clientId)).map((row) => ({
    scope: text(row.scope) as CustomerPaymentPreference["scope"],
    methodKind: text(row.method_kind) as CustomerPaymentPreference["methodKind"],
    lastSelectedAt: text(row.last_selected_at),
  }));
}

// Saved delivery selections, newest first. Mirrors readPaymentPreferences; the row→camelCase
// shape matches customerDeliveryPreferenceSchema so the account V2 response can carry it and
// the configurator can prefill the chosen carrier/paczkomat for a logged-in customer.
export async function readDeliveryPreferences(
  store: CustomerAccountReadStore,
  clientId: string,
): Promise<CustomerDeliveryPreference[]> {
  type PickupPoint = CustomerDeliveryPreference["pickupPoint"];
  return (await store.readDeliveryPreferences(clientId)).map((row) => ({
    scope: text(row.scope) as CustomerDeliveryPreference["scope"],
    deliveryKind: text(row.delivery_kind) as CustomerDeliveryPreference["deliveryKind"],
    providerKind: text(row.provider_kind) as CustomerDeliveryPreference["providerKind"],
    carrierKind: text(row.carrier_kind),
    carrierCode: text(row.carrier_code),
    serviceCode: text(row.service_code),
    pickupPoint: row.pickup_point_id
      ? ({
          id: text(row.pickup_point_id),
          name: text(row.pickup_point_name),
          address: (row.pickup_point_address ?? null) as NonNullable<PickupPoint>["address"],
        } satisfies NonNullable<PickupPoint>)
      : null,
    lastSelectedAt: text(row.last_selected_at),
  }));
}

export async function readEvents(
  store: CustomerAccountReadStore,
  clientId: string,
): Promise<CustomerAccountResponse["events"]> {
  return (await store.readEvents(clientId)).map((row) => ({
    eventId: text(row.id),
    eventType: text(row.event_type),
    entityType: text(row.entity_type),
    entityId: nullableText(row.entity_id),
    occurredAt: text(row.occurred_at),
  }));
}

export async function recordEvent(
  store: CustomerAccountReadStore,
  clientId: string,
  eventType: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await store.recordEvent({
    clientId,
    eventType,
    entityType,
    entityId,
    payload,
  });
}

export async function petHasActiveSubscription(store: CustomerAccountReadStore, clientId: string, petId: string) {
  return store.petHasActiveSubscription(clientId, petId);
}

async function readSubscriptionLines(store: CustomerAccountReadStore, subscriptionIds: string[]) {
  const map = new Map<string, CustomerAccountResponse["subscriptions"][number]["lines"]>();
  if (subscriptionIds.length === 0) return map;
  for (const row of await store.readSubscriptionLines(subscriptionIds)) {
    const subscriptionId = text(row.subscription_id);
    const lines = map.get(subscriptionId) ?? [];
    lines.push({
      lineId: text(row.id),
      variantId: text(row.variant_id),
      qty: Number(row.qty),
      sortOrder: Number(row.sort_order),
      isAddon: Boolean(row.is_addon),
    });
    map.set(subscriptionId, lines);
  }
  return map;
}

function editCutoff(nextCycleAt: string | null, editWindowHours: number | null): string | null {
  if (!nextCycleAt) return null;
  const date = new Date(nextCycleAt);
  date.setHours(date.getHours() - (editWindowHours ?? 72));
  return date.toISOString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
