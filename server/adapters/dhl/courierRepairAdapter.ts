import {
  FulfillmentPreflightError,
  type FulfillmentDhlShipmentPort as ShipmentPort,
} from "../../../src/domains/fulfillment/ports.js";
import { mapLegacyDhlError as mapLegacyCarrierError } from "./courierAdapter.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  createCarrierPickupRepairAction,
  type CourierRepairInput,
  type CourierRepairOutput,
} from "./courierPickupRepairAction.js";
import {
  CARRIER_PERSISTENCE,
  CARRIER_LEGACY_PORT_METHOD,
  CARRIER_ROUTE_MESSAGE,
} from "./courierPickupStore.js";

const RETIRED_CARRIER_DISPLAY_NAME = "DHL";

interface LegacyRepairPickupResponse {
  mode?: "dry_run" | "commit";
  pickup_id?: string;
  pickup_status?: string;
  courier_order?: string;
  recorded_shipments_count?: number;
  linked_shipments_count?: number;
  expected_shipments_count?: number;
  can_commit?: boolean;
  committed?: boolean;
  already_repaired?: boolean;
  tester_statuses?: Array<{
    tester_id?: string;
    tracking_number?: string | null;
    [CARRIER_PERSISTENCE.shipmentDispatchId]?: string | null;
    status?: string | null;
    email_status?: string | null;
    email_already_sent?: boolean;
    will_request_email?: boolean;
  }>;
  email_dedup_preview?: {
    send_emails?: boolean;
    already_sent_count?: number;
    request_count?: number;
  };
  error_code?: string;
  error?: unknown;
  provider_error?: Parameters<typeof mapLegacyCarrierError>[2];
}

export type CarrierRepairRuntimeEnv = Record<string, string | undefined>;
export type CarrierRepairRunner = (
  request: { accessToken: string | null; body: Record<string, unknown> },
  env?: CarrierRepairRuntimeEnv,
  fetchImpl?: typeof fetch,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export function createDhlCourierRepairPort(options: {
  accessToken: string | null;
  env?: CarrierRepairRuntimeEnv;
  runCourier?: CarrierRepairRunner;
}): ShipmentPort {
  const runCourier = options.runCourier ?? runCarrierPickupRepair;
  return {
    async [CARRIER_LEGACY_PORT_METHOD.createShipment]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.createShipment);
    },
    async [CARRIER_LEGACY_PORT_METHOD.label]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.label);
    },
    async [CARRIER_LEGACY_PORT_METHOD.mergeLabels]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.mergeLabels);
    },
    async [CARRIER_LEGACY_PORT_METHOD.bookCourier]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.bookCourier);
    },
    async [CARRIER_LEGACY_PORT_METHOD.repairCourier]({
      pickupId,
      mode,
      sendEmails,
      expectedCourierOrderId,
      expectedShipmentCount,
    }) {
      if (mode !== "dry_run" || sendEmails) {
        throw new FulfillmentPreflightError("Standalone DHL repair mutation and email are retired", {
          reason: "direct_dhl_repair_mutation_retired",
        });
      }
      const result = await runCourier({
        accessToken: options.accessToken,
        body: {
          pickup_id: pickupId,
          mode,
          send_emails: sendEmails,
          expected_courier_order_id: expectedCourierOrderId,
          expected_shipment_count: expectedShipmentCount,
        },
      }, options.env);
      const data = result.body as LegacyRepairPickupResponse;
      if (result.status < 200 || result.status >= 300) {
        throw mapLegacyCarrierError(data.error ?? `repair_dhl_courier_pickup_http_${result.status}`, data.error_code, data.provider_error);
      }
      if (data?.error) throw mapLegacyCarrierError(data.error, data.error_code, data.provider_error);

      return mapLegacyRepairPickupResponse(data ?? {});
    },
    async [CARRIER_LEGACY_PORT_METHOD.clearShipmentState]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.clearShipmentState);
    },
  };
}

// This diagnostic runner reads only persisted pickup/tester evidence. It never
// constructs a DHL request, mutates a tester, or composes an email.
const runCarrierPickupRepair: CarrierRepairRunner = async (
  request,
  env = process.env,
  _fetchImpl = fetch,
) => {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { status: 500, body: { error: "supabase_service_role_not_configured" } };
  }
  try {
    const action = createCarrierPickupRepairAction({
      client: createServiceRoleClient({ url, serviceRoleKey }) as never,
    });
    return toLegacyRepairRunResult(await action(toRepairActionInput(request)));
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : `${RETIRED_CARRIER_DISPLAY_NAME} repair failed` } };
  }
};

function toRepairActionInput(request: Parameters<CarrierRepairRunner>[0]): CourierRepairInput {
  const body = request.body;
  return {
    accessToken: request.accessToken,
    pickupId: String(body.pickup_id ?? ""),
    mode: body.mode === "commit" ? "commit" : "dry_run",
    sendEmails: Boolean(body.send_emails),
    expectedCourierOrderId: String(body.expected_courier_order_id ?? ""),
    expectedShipmentCount: Number(body.expected_shipment_count ?? 0),
  };
}

function toLegacyRepairRunResult(result: CourierRepairOutput) {
  if (!result.success) {
    return { status: 400, body: { error: result.error, error_code: result.errorCode } };
  }
  return {
    status: 200,
    body: {
      mode: result.mode,
      pickup_id: result.pickupId,
      pickup_status: result.pickupStatus,
      courier_order: result.courierOrderId,
      recorded_shipments_count: result.recordedShipmentsCount,
      linked_shipments_count: result.linkedShipmentsCount,
      expected_shipments_count: result.expectedShipmentsCount,
      can_commit: result.canCommit,
      committed: result.committed,
      already_repaired: result.alreadyRepaired,
      tester_statuses: result.testerStatuses?.map((tester) => ({
        tester_id: tester.testerId,
        tracking_number: tester.trackingNumber,
        [CARRIER_PERSISTENCE.shipmentDispatchId]: tester.shipmentDispatchId,
        status: tester.status,
        email_status: tester.emailStatus,
        email_already_sent: tester.emailAlreadySent,
        will_request_email: tester.willRequestEmail,
      })),
      email_dedup_preview: {
        send_emails: result.emailDedupPreview?.sendEmails,
        already_sent_count: result.emailDedupPreview?.alreadySentCount,
        request_count: result.emailDedupPreview?.requestCount,
      },
    },
  };
}

function mapLegacyRepairPickupResponse(
  data: LegacyRepairPickupResponse,
) {
  return {
    mode: data.mode ?? "dry_run",
    pickupId: data.pickup_id ?? "",
    pickupStatus: data.pickup_status ?? "",
    courierOrderId: data.courier_order ?? "",
    recordedShipmentsCount: data.recorded_shipments_count ?? 0,
    linkedShipmentsCount: data.linked_shipments_count ?? 0,
    expectedShipmentsCount: data.expected_shipments_count ?? 0,
    canCommit: data.can_commit ?? false,
    committed: data.committed ?? false,
    alreadyRepaired: data.already_repaired ?? false,
    testerStatuses: (data.tester_statuses ?? []).map((tester) => ({
      testerId: tester.tester_id ?? "",
      trackingNumber: tester.tracking_number ?? null,
      dhlShipmentId: tester[CARRIER_PERSISTENCE.shipmentDispatchId] ?? null,
      status: tester.status ?? null,
      emailStatus: tester.email_status ?? null,
      emailAlreadySent: tester.email_already_sent ?? false,
      willRequestEmail: tester.will_request_email ?? false,
    })),
    emailDedupPreview: {
      sendEmails: data.email_dedup_preview?.send_emails ?? false,
      alreadySentCount: data.email_dedup_preview?.already_sent_count ?? 0,
      requestCount: data.email_dedup_preview?.request_count ?? 0,
    },
  };
}

export const runDhlCourierRepair = runCarrierPickupRepair;
export const mapLegacyRepairDhlCourierPickupResponse = mapLegacyRepairPickupResponse;
