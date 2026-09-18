/* eslint-disable @typescript-eslint/no-explicit-any -- provider query client is structural at this boundary. */
import {
  CARRIER_DISPLAY_NAME,
  extractCarrierPickupOrderId,
} from "../../infra/dhl/adminDhlSoap.js";
import {
  CARRIER_PERSISTENCE,
} from "./courierPickupStore.js";

type Client = { auth: { getUser: (token: string) => Promise<any> }; from: (table: string) => any };
type RepairMode = "dry_run" | "commit";
type TesterStatus = {
  testerId: string;
  trackingNumber: string | null;
  shipmentDispatchId: string | null;
  status: string | null;
  emailStatus: string | null;
  emailAlreadySent: boolean;
  willRequestEmail: boolean;
};

export type CourierRepairInput = {
  accessToken: string | null;
  pickupId: string;
  mode: RepairMode;
  sendEmails: boolean;
  expectedCourierOrderId: string;
  expectedShipmentCount: number;
};

export type CourierRepairOutput = {
  success: boolean;
  error?: string;
  errorCode?: string;
  mode?: RepairMode;
  pickupId?: string;
  pickupStatus?: string;
  courierOrderId?: string;
  recordedShipmentsCount?: number;
  linkedShipmentsCount?: number;
  expectedShipmentsCount?: number;
  canCommit?: boolean;
  committed?: boolean;
  alreadyRepaired?: boolean;
  testerStatuses?: TesterStatus[];
  emailDedupPreview?: { sendEmails: boolean; alreadySentCount: number; requestCount: number };
};

export function createCarrierPickupRepairAction(deps: {
  client: Client;
  log?: (...args: unknown[]) => void;
}) {
  const log = deps.log ?? (() => undefined);
  return async (input: CourierRepairInput): Promise<CourierRepairOutput> => {
    if (input.mode !== "dry_run" || input.sendEmails) {
      return failure("Standalone DHL repair mutation and email are retired", "REPAIR_MUTATION_RETIRED");
    }
    const authError = await assertAdmin(deps.client, input.accessToken);
    if (authError) return failure(authError);
    const context = await loadContext(deps.client, input.pickupId, log);
    if (typeof context === "string") return failure(context);
    const evaluated = evaluate(input, context);
    return dryRunResponse(input, context, typeof evaluated === "string" ? context.courierOrderId : evaluated.courierOrderId);
  };
}

async function assertAdmin(client: Client, accessToken: string | null): Promise<string | null> {
  if (!accessToken) return "Brak tokenu autoryzacji";
  const user = await client.auth.getUser(accessToken);
  if (user.error || !user.data?.user) return `Auth error: ${user.error?.message || "no user"}`;
  const { data: admin } = await client.from("admin_users").select("id").eq("id", user.data.user.id).maybeSingle();
  return admin ? null : "Nie jesteś adminem";
}

async function loadContext(client: Client, pickupId: string, log: (...args: unknown[]) => void): Promise<RepairContext | string> {
  const pickupResult = await client.from(CARRIER_PERSISTENCE.pickupTable)
    .select("id,status,courier_order_id,shipments_count,raw_response_excerpt")
    .eq("id", pickupId)
    .maybeSingle();
  if (pickupResult.error) return pickupResult.error.message ?? `Nie udało się pobrać wpisu ${CARRIER_DISPLAY_NAME} courier pickup`;
  if (!pickupResult.data) return `Nie znaleziono wskazanego wpisu ${CARRIER_DISPLAY_NAME} courier pickup`;
  const shipmentResult = await client.from(CARRIER_PERSISTENCE.pickupShipmentTable)
    .select(CARRIER_PERSISTENCE.pickupShipmentSelection)
    .eq(CARRIER_PERSISTENCE.pickupId, pickupId);
  if (shipmentResult.error) return shipmentResult.error.message ?? `Nie udało się pobrać paczek z wpisu ${CARRIER_DISPLAY_NAME}`;
  const shipments = Array.isArray(shipmentResult.data) ? shipmentResult.data : [];
  const testerIds = shipments.map((row: any) => stringOrNull(row.tester_id)).filter(Boolean) as string[];
  const testerResult = testerIds.length
    ? await client.from("testers").select(CARRIER_PERSISTENCE.testerSelection).in("id", testerIds)
    : { data: [] };
  if (testerResult.error) return testerResult.error.message ?? `Nie udało się pobrać testerów dla naprawy ${CARRIER_DISPLAY_NAME}`;
  const testers = Array.isArray(testerResult.data) ? testerResult.data : [];
  if (testers.length !== testerIds.length) return `Nie znaleziono testerów dla wpisu ${CARRIER_DISPLAY_NAME}: ${missingIds(testerIds, testers).join(", ")}`;
  const emailStatusByTester = await loadEmailStatus(client, testerIds, log);
  const pickup = pickupResult.data;
  const rawResponse = stringOrNull(pickup.raw_response_excerpt);
  const parsedCourierOrderId = rawResponse ? extractCarrierPickupOrderId(rawResponse) : null;
  const storedCourierOrderId = stringOrNull(pickup.courier_order_id);
  const alreadyRepaired = pickup.status === "succeeded";
  return {
    pickup,
    shipments,
    testersById: new Map(testers.map((tester: any) => [String(tester.id), tester])),
    emailStatusByTester,
    testerIds,
    parsedCourierOrderId,
    storedCourierOrderId,
    courierOrderId: parsedCourierOrderId ?? storedCourierOrderId,
    alreadyRepaired,
  };
}

async function loadEmailStatus(client: Client, testerIds: string[], log: (...args: unknown[]) => void) {
  const statuses = new Map<string, string>();
  if (!testerIds.length) return statuses;
  try {
    const result = await client.from("email_sends")
      .select("tester_id, template_slug, status")
      .in("tester_id", testerIds)
      .eq("template_slug", "shipped");
    for (const row of Array.isArray(result.data) ? result.data : []) {
      const testerId = stringOrNull(row.tester_id);
      const status = stringOrNull(row.status);
      if (testerId && status && (!statuses.has(testerId) || statuses.get(testerId) === "failed")) {
        statuses.set(testerId, status);
      }
    }
  } catch (error) {
    log("[COURIER_REPAIR] Email dedup preview lookup failed:", String(error));
  }
  return statuses;
}

function evaluate(input: CourierRepairInput, context: RepairContext): { courierOrderId: string } | string {
  const pickupStatus = stringOrNull(context.pickup.status) ?? "unknown";
  if (pickupStatus !== "indeterminate" && pickupStatus !== "succeeded") {
    return `Wpis ${CARRIER_DISPLAY_NAME} courier pickup ma status ${pickupStatus}; naprawa obsługuje tylko indeterminate/succeeded`;
  }
  if (!context.alreadyRepaired && !context.parsedCourierOrderId) {
    return `Zapisana odpowiedź ${CARRIER_DISPLAY_NAME} nie zawiera rozpoznawalnego numeru zamówienia kuriera`;
  }
  if (context.courierOrderId !== input.expectedCourierOrderId) {
    return `Rozpoznany numer zamówienia kuriera (${context.courierOrderId ?? "brak"}) nie zgadza się z oczekiwanym ${input.expectedCourierOrderId}`;
  }
  if (context.alreadyRepaired && context.storedCourierOrderId !== input.expectedCourierOrderId) {
    return `Wpis jest już succeeded z innym numerem zamówienia kuriera (${context.storedCourierOrderId ?? "brak"})`;
  }
  const recorded = numberOrZero(context.pickup.shipments_count);
  if (recorded !== input.expectedShipmentCount) {
    return `Liczba paczek w wpisie (${recorded}) nie zgadza się z oczekiwaną ${input.expectedShipmentCount}`;
  }
  if (context.shipments.length !== input.expectedShipmentCount) {
    return `Liczba powiązanych paczek (${context.shipments.length}) nie zgadza się z oczekiwaną ${input.expectedShipmentCount}`;
  }
  if (context.testerIds.length !== input.expectedShipmentCount) {
    return `Lista powiązanych testerów (${context.testerIds.length}) nie zgadza się z oczekiwaną liczbą paczek ${input.expectedShipmentCount}`;
  }
  const unsafe = testerStatuses(context, false)
    .filter((tester) => tester.status !== "packing" && tester.status !== "shipped");
  if (unsafe.length) {
    return `Naprawa ${CARRIER_DISPLAY_NAME} może przesunąć tylko paczki packing/shipped; blokują: ${unsafe.map((tester) => tester.testerId).join(", ")}`;
  }
  return { courierOrderId: context.courierOrderId! };
}

function dryRunResponse(
  input: CourierRepairInput,
  context: RepairContext,
  order: string | null,
): CourierRepairOutput {
  const statuses = testerStatuses(context, false);
  return {
    success: true,
    mode: input.mode,
    pickupId: input.pickupId,
    pickupStatus: String(context.pickup.status ?? "unknown"),
    courierOrderId: order ?? "",
    recordedShipmentsCount: numberOrZero(context.pickup.shipments_count),
    linkedShipmentsCount: context.shipments.length,
    expectedShipmentsCount: input.expectedShipmentCount,
    canCommit: false,
    committed: false,
    alreadyRepaired: context.alreadyRepaired,
    testerStatuses: statuses,
    emailDedupPreview: {
      sendEmails: false,
      alreadySentCount: statuses.filter((tester) => tester.emailAlreadySent).length,
      requestCount: 0,
    },
  };
}

function testerStatuses(context: RepairContext, willRequestEmail: boolean): TesterStatus[] {
  return context.shipments.map((shipment: any) => {
    const testerId = stringOrNull(shipment.tester_id) ?? "";
    const tester = context.testersById.get(testerId) ?? {};
    const emailStatus = context.emailStatusByTester.get(testerId) ?? null;
    return {
      testerId,
      trackingNumber: stringOrNull(tester.tracking_number) ?? stringOrNull(shipment.tracking_number_snapshot),
      shipmentDispatchId: stringOrNull(tester[CARRIER_PERSISTENCE.shipmentDispatchId])
        ?? stringOrNull(shipment[CARRIER_PERSISTENCE.shipmentDispatchIdSnapshot]),
      status: stringOrNull(tester.status),
      emailStatus,
      emailAlreadySent: Boolean(emailStatus && emailStatus !== "failed"),
      willRequestEmail,
    };
  });
}

function failure(error: string, errorCode = "REPAIR_PRECONDITION_FAILED"): CourierRepairOutput { return { success: false, error, errorCode }; }
function stringOrNull(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function numberOrZero(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function missingIds(ids: string[], testers: any[]) { const found = new Set(testers.map((tester) => String(tester.id))); return ids.filter((id) => !found.has(id)); }

type RepairContext = {
  pickup: any;
  shipments: any[];
  testersById: Map<string, any>;
  emailStatusByTester: Map<string, string>;
  testerIds: string[];
  parsedCourierOrderId: string | null;
  storedCourierOrderId: string | null;
  courierOrderId: string | null;
  alreadyRepaired: boolean;
};
