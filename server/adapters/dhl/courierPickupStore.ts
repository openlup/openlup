/* eslint-disable @typescript-eslint/no-explicit-any -- shared store accepts the structural database client. */
import { CARRIER_DISPLAY_NAME } from "../../infra/dhl/adminDhlSoap.js";
import { WARSAW_TIME_ZONE } from "../../infra/dhl/commerceShipmentSoap.js";

/**
 * Stable persistence and compatibility keys for this carrier capability.
 * Values are kept here so the booking, recovery and legacy BFF ports consume
 * one auditable database/response contract.
 */
export const CARRIER_PERSISTENCE = {
  pickupTable: "dhl_courier_pickups",
  pickupShipmentTable: "dhl_courier_pickup_shipments",
  bookingIdempotencyPrefix: "dhl-courier",
  shipmentDispatchId: "dhl_shipment_id",
  shipmentDate: "dhl_shipment_date",
  shipmentDispatchIdSnapshot: "dhl_shipment_id_snapshot",
  shipmentDateSnapshot: "dhl_shipment_date_snapshot",
  pickupId: "pickup_id",
  idempotencyKey: "idempotency_key",
  bookingEmailSource: "book-dhl-courier",
  repairEmailSource: "repair-dhl-courier-pickup",
  shipmentEmailSource: "create-dhl-shipment",
  labelBucket: "dhl-labels",
  pickupSelection: "courier_order_id, shipments_count, status, operator_message, support_code, raw_response_excerpt",
  pickupShipmentSelection: "tester_id,tracking_number_snapshot,dhl_shipment_id_snapshot,dhl_shipment_date_snapshot",
  testerSelection: "id, first_name, last_name, status, tracking_number, label_url, dhl_shipment_id, dhl_shipment_date",
} as const;

export const CARRIER_SHIPPER_SETTING = {
  matchingKey: "dhl_shipper_%",
  name: "dhl_shipper_name",
  street: "dhl_shipper_street",
  houseNumber: "dhl_shipper_house_number",
  postalCode: "dhl_shipper_postal_code",
  city: "dhl_shipper_city",
  contactPerson: "dhl_shipper_contact_person",
  phone: "dhl_shipper_phone",
  email: "dhl_shipper_email",
} as const;

export const CARRIER_ROUTE_MESSAGE = {
  createShipment: "Use dhl-create-shipment route",
  label: "Use dhl-label route",
  mergeLabels: "Use dhl-merge-labels route",
  bookCourier: "Use dhl-book-courier route",
  repairCourier: "Use dhl-repair-courier-pickup route",
  clearShipmentState: "Use dhl-clear-shipment-state route",
} as const;

/** Legacy port member names are public compatibility keys, not new domain names. */
export const CARRIER_LEGACY_PORT_METHOD = {
  createShipment: "createDhlShipment",
  label: "getDhlLabel",
  mergeLabels: "mergeDhlLabels",
  bookCourier: "bookDhlCourier",
  repairCourier: "repairDhlCourierPickup",
  clearShipmentState: "clearDhlShipmentState",
} as const;

export type CourierPickupTester = {
  id: string; status: string | null; tracking_number: string | null; label_url: string | null;
  [CARRIER_PERSISTENCE.shipmentDispatchId]: string | null;
  [CARRIER_PERSISTENCE.shipmentDate]: string | null;
};

type Client = { from: (table: string) => any };

export type StoredCourierPickup = {
  status: "succeeded" | "indeterminate"; courierOrderId: string | null; shipmentsCount: number;
  operatorMessage: string | null; supportCode: string | null; rawResponseExcerpt: string | null;
};

export async function loadCarrierShipperContact(client: Client): Promise<{
  contactPerson: string;
  contactPhone: string;
}> {
  const { data } = await client.from("settings")
    .select("key, value")
    .like("key", CARRIER_SHIPPER_SETTING.matchingKey);
  const settings: Record<string, string> = {};
  for (const row of data ?? []) {
    try { settings[row.key] = typeof row.value === "string" ? JSON.parse(row.value) : String(row.value); }
    catch { settings[row.key] = String(row.value); }
  }
  return {
    contactPerson: settings[CARRIER_SHIPPER_SETTING.contactPerson] ?? "",
    contactPhone: settings[CARRIER_SHIPPER_SETTING.phone] ?? "",
  };
}

export const makePickupIdempotencyKey = (ids: string[], date: string, from: string, to: string) =>
  [CARRIER_PERSISTENCE.bookingIdempotencyPrefix, date, from, to, [...ids].sort().join(",")].join("|");

export async function findCourierPickup(client: Client, idempotencyKey: string): Promise<StoredCourierPickup | null> {
  try {
    const result = await client.from(CARRIER_PERSISTENCE.pickupTable)
      .select(CARRIER_PERSISTENCE.pickupSelection)
      .eq(CARRIER_PERSISTENCE.idempotencyKey, idempotencyKey)
      .maybeSingle();
    const row = result.data;
    if (row?.status !== "succeeded" && row?.status !== "indeterminate") return null;
    return { status: row.status, courierOrderId: typeof row.courier_order_id === "string" ? row.courier_order_id : null,
      shipmentsCount: typeof row.shipments_count === "number" ? row.shipments_count : 0,
      operatorMessage: typeof row.operator_message === "string" ? row.operator_message : null,
      supportCode: typeof row.support_code === "string" ? row.support_code : null,
      rawResponseExcerpt: typeof row.raw_response_excerpt === "string" ? row.raw_response_excerpt : null };
  } catch { return null; }
}

export async function recordCourierPickup(client: Client, input: {
  status: "succeeded" | "failed" | "indeterminate";
  idempotencyKey: string; courierOrderId?: string | null;
  pickupDate: string; pickupTimeFrom: string; pickupTimeTo: string;
  additionalInfo: string; requestedBy: string;
  testers: CourierPickupTester[];
  operatorMessage?: string; retryable?: boolean;
  supportCode?: string; rawResponse?: string;
}): Promise<string | null> {
  try {
    const result = await client.from(CARRIER_PERSISTENCE.pickupTable).upsert({
      status: input.status, idempotency_key: input.idempotencyKey,
      courier_order_id: input.courierOrderId ?? null, pickup_date: input.pickupDate,
      pickup_time_from: input.pickupTimeFrom, pickup_time_to: input.pickupTimeTo,
      shipments_count: input.testers.length, additional_info: input.additionalInfo || null,
      requested_by: input.requestedBy, operator_message: input.operatorMessage ?? null,
      retryable: input.retryable ?? null, support_code: input.supportCode ?? null,
      raw_response_excerpt: input.rawResponse?.slice(0, 2000) ?? null,
    }, { onConflict: CARRIER_PERSISTENCE.idempotencyKey }).select("id").single();
    const id = typeof result.data?.id === "string" ? result.data.id : null;
    if (!id) return null;
    await client.from(CARRIER_PERSISTENCE.pickupShipmentTable).upsert(input.testers.map((tester) => ({
      [CARRIER_PERSISTENCE.pickupId]: id,
      tester_id: tester.id,
      tracking_number_snapshot: tester.tracking_number,
      [CARRIER_PERSISTENCE.shipmentDispatchIdSnapshot]: tester[CARRIER_PERSISTENCE.shipmentDispatchId],
      [CARRIER_PERSISTENCE.shipmentDateSnapshot]: tester[CARRIER_PERSISTENCE.shipmentDate],
    })), { onConflict: "pickup_id,tester_id" });
    return id;
  } catch { return null; }
}

export async function reconcileShippedTesters(
  client: Client,
  testers: CourierPickupTester[],
  timestamp: string,
  sendEmail?: (id: string, slug: string, source: string) => Promise<unknown>,
  source: string = CARRIER_PERSISTENCE.bookingEmailSource,
): Promise<string[]> {
  const failed: string[] = [];
  for (const tester of testers) {
    const { error } = await client.from("testers")
      .update({ status: "shipped", status_updated_at: timestamp })
      .eq("id", tester.id);
    if (error) { failed.push(tester.id); continue; }
    try { await sendEmail?.(tester.id, "shipped", source); }
    catch { /* best effort */ }
  }
  return failed;
}

export function validateCarrierPickupTesters(testers: CourierPickupTester[], ids: string[]): string | null {
  if (testers.length !== ids.length) return "Nie znaleziono wszystkich wybranych testerów";
  if (testers.some((tester) => tester.status !== "packing")) {
    return `Kurier ${CARRIER_DISPLAY_NAME} może być zamówiony tylko dla paczek w pakowaniu`;
  }
  const hasIncompleteShipment = testers.some(
    (tester) =>
      !tester.tracking_number ||
      !tester.label_url ||
      !tester[CARRIER_PERSISTENCE.shipmentDispatchId],
  );
  if (hasIncompleteShipment) {
    return `Wybrano paczki bez kompletnej etykiety lub identyfikatora ${CARRIER_DISPLAY_NAME}`;
  }
  if (testers.some((tester) => !tester[CARRIER_PERSISTENCE.shipmentDate])) {
    return (
      `Wybrano paczki bez zapisanej daty nadania ${CARRIER_DISPLAY_NAME}. ` +
      `Zregeneruj etykiety albo nadaj je osobno po sprawdzeniu w ${CARRIER_DISPLAY_NAME}.`
    );
  }
  const dates = [...new Set(testers.map((tester) => tester[CARRIER_PERSISTENCE.shipmentDate]).filter(Boolean))];
  return dates.length > 1
    ? `Wybrane paczki mają różne daty nadania ${CARRIER_DISPLAY_NAME} (${dates.sort().join(", ")}). ` +
        "Zamów kuriera osobno dla każdej daty."
    : null;
}

export function validateCarrierPickupWindow(date: string, from: string, to: string, timestamp: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `Nieprawidłowa data odbioru ${CARRIER_DISPLAY_NAME}`;
  if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) {
    return `Nieprawidłowe okno godzinowe odbioru ${CARRIER_DISPLAY_NAME}`;
  }
  if (from >= to) return `Godzina odbioru ${CARRIER_DISPLAY_NAME} musi mieć początek przed końcem`;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: WARSAW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  if (date < today) return `Data odbioru ${CARRIER_DISPLAY_NAME} nie może być w przeszłości`;
  if (date === today && from <= `${get("hour")}:${get("minute")}`) {
    return `Godzina odbioru ${CARRIER_DISPLAY_NAME} nie może być w przeszłości`;
  }
  return null;
}

export function normalizeCarrierPickupIds(pickupDate: string, testerIds: string[]) {
  const ids = testerIds.map((id) => String(id).trim()).filter(Boolean);
  if (!pickupDate || !ids.length) return { ids, error: "Brak pickup_date lub tester_ids" };
  if (new Set(ids).size !== testerIds.length) {
    return {
      ids,
      error: "Lista tester_ids zawiera puste lub zdublowane pozycje",
    };
  }
  return { ids, error: null };
}

export function formatCarrierPickupBooking(input: {
  pickupDate: string;
  pickupTimeFrom: string;
  pickupTimeTo: string;
  shipmentsCount: number;
  courierOrderId: string | null;
}) {
  return {
    pickupDate: input.pickupDate,
    pickupTime: `${input.pickupTimeFrom}-${input.pickupTimeTo}`,
    shipmentsCount: input.shipmentsCount,
    courierOrderId: input.courierOrderId,
  };
}

export function createCarrierSupportCode(timestamp: string, seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const stamp = timestamp.replace(/\D/g, "").slice(0, 14).padEnd(14, "0");
  return `${CARRIER_DISPLAY_NAME}-${stamp}-${hash.toString(36).toUpperCase().padStart(6, "0").slice(-6)}`;
}

export function classifyCarrierProviderMessage(message: string) {
  const match = message.match(/Po przesyłkę o id\s+([A-Z0-9-]+)\s+jest już zamówiony kurier/i);
  return match ? { reason: "already_booked" as const, blockingShipmentId: match[1] } : null;
}

export function makeCourierPickupEvidence(input: {
  status: "failed" | "succeeded" | "indeterminate";
  idempotencyKey: string;
  courierOrderId?: string | null;
  pickupDate: string;
  pickupTimeFrom: string;
  pickupTimeTo: string;
  additionalInfo: string;
  requestedBy: string;
  testers: CourierPickupTester[];
  operatorMessage?: string;
  retryable?: boolean;
  supportCode?: string;
  rawResponse?: string;
}) {
  return input;
}

export function makeCourierPickupEvidenceFromRequest(input: {
  status: "failed" | "succeeded" | "indeterminate";
  request: { pickupDate: string; pickupTimeFrom: string; pickupTimeTo: string; additionalInfo: string };
  testers: CourierPickupTester[];
  idempotencyKey: string;
  requestedBy: string;
  courierOrderId?: string | null;
  operatorMessage?: string;
  retryable?: boolean;
  supportCode?: string;
  rawResponse?: string;
}) {
  return makeCourierPickupEvidence({
    status: input.status, idempotencyKey: input.idempotencyKey, courierOrderId: input.courierOrderId,
    pickupDate: input.request.pickupDate, pickupTimeFrom: input.request.pickupTimeFrom,
    pickupTimeTo: input.request.pickupTimeTo, additionalInfo: input.request.additionalInfo,
    requestedBy: input.requestedBy, testers: input.testers, operatorMessage: input.operatorMessage,
    retryable: input.retryable, supportCode: input.supportCode, rawResponse: input.rawResponse,
  });
}

export function createCarrierProviderEvidence(message: string, timestamp: string, retryable: boolean) {
  const classification = classifyCarrierProviderMessage(message);
  return {
    message,
    operatorMessage: `${CARRIER_DISPLAY_NAME}: ${message}`,
    retryable: classification ? false : retryable,
    supportCode: createCarrierSupportCode(timestamp, message),
    details: classification ?? {},
  };
}
