/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase query client is structural at this boundary. */
import { FulfillmentPreflightError } from "../../../src/domains/fulfillment/ports.js";
import { CARRIER_DISPLAY_NAME } from "../../infra/dhl/adminDhlSoap.js";
import { CARRIER_PERSISTENCE, type CourierPickupTester } from "./courierPickupStore.js";

type Client = { from: (table: string) => any };
type PickupStatus = "pending" | "succeeded" | "failed" | "indeterminate";
export type StoredCourierPickup = {
  id: string;
  updatedAt: string;
  status: PickupStatus;
  courierOrderId: string | null;
  shipmentsCount: number;
  operatorMessage: string | null;
  retryable: boolean;
  supportCode: string | null;
  rawResponseExcerpt: string | null;
};

export async function findCourierPickup(client: Client, idempotencyKey: string): Promise<StoredCourierPickup | null> {
  const { data: row, error } = await client.from(CARRIER_PERSISTENCE.pickupTable)
    .select(CARRIER_PERSISTENCE.pickupSelection)
    .eq(CARRIER_PERSISTENCE.idempotencyKey, idempotencyKey)
    .maybeSingle();
  if (error) throw pickupStoreUnavailable();
  if (row == null) return null;
  const status = row.status;
  if (
    typeof row.id !== "string" || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))
    || (status !== "pending" && status !== "succeeded" && status !== "failed" && status !== "indeterminate")
  ) throw pickupStoreUnavailable();
  return {
    id: row.id,
    updatedAt: row.updated_at,
    status,
    courierOrderId: typeof row.courier_order_id === "string" ? row.courier_order_id : null,
    shipmentsCount: typeof row.shipments_count === "number" ? row.shipments_count : 0,
    operatorMessage: typeof row.operator_message === "string" ? row.operator_message : null,
    retryable: row.retryable === true,
    supportCode: typeof row.support_code === "string" ? row.support_code : null,
    rawResponseExcerpt: typeof row.raw_response_excerpt === "string" ? row.raw_response_excerpt : null,
  };
}

export async function claimCourierPickup(client: Client, input: {
  idempotencyKey: string;
  request: { pickupDate: string; pickupTimeFrom: string; pickupTimeTo: string; additionalInfo: string };
  requestedBy: string;
  testers: CourierPickupTester[];
  retryOf: Pick<StoredCourierPickup, "id" | "updatedAt"> | null;
}): Promise<string | null> {
  const table = client.from(CARRIER_PERSISTENCE.pickupTable);
  const claim = input.retryOf
    ? table.update({
      status: "pending",
      updated_at: new Date(Math.max(Date.now(), Date.parse(input.retryOf.updatedAt) + 1)).toISOString(),
      requested_by: input.requestedBy,
      additional_info: input.request.additionalInfo || null,
      operator_message: null,
      retryable: null,
      support_code: null,
      raw_response_excerpt: null,
    }).eq("id", input.retryOf.id).eq("status", "failed").eq("retryable", true).eq("updated_at", input.retryOf.updatedAt)
    : table.upsert({
      status: "pending",
      idempotency_key: input.idempotencyKey,
      pickup_date: input.request.pickupDate,
      pickup_time_from: input.request.pickupTimeFrom,
      pickup_time_to: input.request.pickupTimeTo,
      additional_info: input.request.additionalInfo || null,
      requested_by: input.requestedBy,
      shipments_count: input.testers.length,
    }, { onConflict: CARRIER_PERSISTENCE.idempotencyKey, ignoreDuplicates: true });

  const { data, error } = await claim.select("id").maybeSingle();
  if (error || (data != null && typeof data.id !== "string")) throw pickupStoreUnavailable();
  return data?.id ?? null;
}

export async function recordCourierPickupShipments(client: Client, pickupId: string, testers: CourierPickupTester[]) {
  const { error } = await client.from(CARRIER_PERSISTENCE.pickupShipmentTable).upsert(testers.map((tester) => ({
    [CARRIER_PERSISTENCE.pickupId]: pickupId,
    tester_id: tester.id,
    tracking_number_snapshot: tester.tracking_number,
    [CARRIER_PERSISTENCE.shipmentDispatchIdSnapshot]: tester[CARRIER_PERSISTENCE.shipmentDispatchId],
    [CARRIER_PERSISTENCE.shipmentDateSnapshot]: tester[CARRIER_PERSISTENCE.shipmentDate],
  })), { onConflict: "pickup_id,tester_id" });
  if (error) throw pickupStoreUnavailable();
}

export async function recordCourierPickup(client: Client, pickupId: string, previous: "pending" | "indeterminate", input: {
  status: Exclude<PickupStatus, "pending">;
  courierOrderId?: string;
  operatorMessage?: string;
  retryable?: boolean;
  supportCode?: string;
  rawResponse?: string;
}): Promise<boolean> {
  try {
    const { data, error } = await client.from(CARRIER_PERSISTENCE.pickupTable).update({
      status: input.status,
      courier_order_id: input.courierOrderId ?? null,
      operator_message: input.operatorMessage ?? null,
      retryable: input.retryable ?? null,
      support_code: input.supportCode ?? null,
      raw_response_excerpt: input.rawResponse?.slice(0, 2000) ?? null,
    }).eq("id", pickupId).eq("status", previous).select("id").maybeSingle();
    return !error && data?.id === pickupId;
  } catch {
    // The database may have applied the update. Never infer a safe retry.
    return false;
  }
}

function pickupStoreUnavailable() {
  return new FulfillmentPreflightError(`Nie udało się potwierdzić zapisu rezerwacji ${CARRIER_DISPLAY_NAME}`, {
    errorCode: "LOCAL_PICKUP_STORE_UNAVAILABLE",
  });
}
