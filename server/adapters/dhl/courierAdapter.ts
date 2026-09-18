import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
  type FulfillmentDhlShipmentPort,
} from "../../../src/domains/fulfillment/ports.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  CARRIER_DISPLAY_NAME,
  CARRIER_ENV_KEYS,
  CARRIER_PROVIDER_ERROR_CODE,
} from "../../infra/dhl/adminDhlSoap.js";
import { sendStatusEmailInProcess } from "./edgeHandlerRuntimeLoader.js";
import { createCarrierPickupBookingAction } from "./courierBookingAction.js";
import {
  CARRIER_LEGACY_PORT_METHOD,
  CARRIER_ROUTE_MESSAGE,
} from "./courierPickupStore.js";

interface LegacyPickupResponse {
  pickup_date?: string;
  pickup_time?: string;
  shipments_count?: number;
  courier_order?: string | null;
  error_code?: string;
  error?: unknown;
  provider_error?: {
    provider?: string;
    operator_message?: string;
    operatorMessage?: string;
    retryable?: boolean;
    support_code?: string;
    supportCode?: string;
    reason?: string;
    blocking_shipment_id?: string;
    blockingShipmentId?: string;
  };
}

export type CarrierPickupRuntimeEnv = Record<string, string | undefined> & {
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  [CARRIER_ENV_KEYS.username]?: string;
  [CARRIER_ENV_KEYS.password]?: string;
};

export type CarrierPickupRunner = (
  request: { accessToken: string | null; body: Record<string, unknown> },
  env?: DhlCourierRuntimeEnv,
  fetchImpl?: typeof fetch,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type DhlCourierRuntimeEnv = CarrierPickupRuntimeEnv;
export type DhlCourierRunner = CarrierPickupRunner;

export function createDhlCourierPort(options: {
  accessToken: string | null;
  env?: CarrierPickupRuntimeEnv;
  runCourier?: CarrierPickupRunner;
}): FulfillmentDhlShipmentPort {
  const runCourier = options.runCourier ?? runCarrierPickup;
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
    async [CARRIER_LEGACY_PORT_METHOD.bookCourier]({
      pickupDate,
      pickupTimeFrom,
      pickupTimeTo,
      additionalInfo,
      testerIds,
    }) {
      const result = await runCourier({
        accessToken: options.accessToken,
        body: {
          pickup_date: pickupDate,
          pickup_time_from: pickupTimeFrom,
          pickup_time_to: pickupTimeTo,
          additional_info: additionalInfo,
          tester_ids: testerIds,
        },
      }, options.env);
      const data = result.body as LegacyPickupResponse;
      if (result.status < 200 || result.status >= 300) {
        throw mapLegacyCarrierError(
          data.error ?? `book_dhl_courier_http_${result.status}`,
          data.error_code,
          data.provider_error,
        );
      }
      if (data?.error) throw mapLegacyCarrierError(data.error, data.error_code, data.provider_error);
      return mapLegacyPickupResponse(data ?? {});
    },
    async [CARRIER_LEGACY_PORT_METHOD.repairCourier]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.repairCourier);
    },
    async [CARRIER_LEGACY_PORT_METHOD.clearShipmentState]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.clearShipmentState);
    },
  };
}

const runCarrierPickup: CarrierPickupRunner = async (
  request,
  env = process.env,
  fetchImpl = fetch,
) => {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { status: 500, body: { error: "supabase_service_role_not_configured" } };
  }
  if (!env[CARRIER_ENV_KEYS.username] || !env[CARRIER_ENV_KEYS.password]) {
    return { status: 500, body: { error: "dhl_credentials_not_configured" } };
  }

  try {
    const action = createCarrierPickupBookingAction({
    client: createServiceRoleClient({ url, serviceRoleKey }) as never,
    fetchImpl,
    auth: {
      username: env[CARRIER_ENV_KEYS.username]!,
      password: env[CARRIER_ENV_KEYS.password]!,
    },
    sendEmail: (testerId, templateSlug, source) =>
      sendStatusEmailInProcess({
        serviceRoleKey,
        testerId,
        templateSlug,
        source,
        env,
        fetchImpl,
      }),
    });
    const body = request.body;
    const result = await action({
      accessToken: request.accessToken,
      pickupDate: String(body.pickup_date ?? ""),
      pickupTimeFrom: String(body.pickup_time_from ?? ""),
      pickupTimeTo: String(body.pickup_time_to ?? ""),
      additionalInfo: String(body.additional_info ?? ""),
      testerIds: Array.isArray(body.tester_ids) ? body.tester_ids.map(String) : [],
    });
    return {
      status: 200,
      body: {
        pickup_date: result.pickupDate,
        pickup_time: result.pickupTime,
        shipments_count: result.shipmentsCount,
        courier_order: result.courierOrderId,
      },
    };
  } catch (error) {
    return errorToLegacyCourierResponse(error);
  }
};

function mapLegacyPickupResponse(data: LegacyPickupResponse) {
  return {
    pickupDate: data.pickup_date ?? "",
    pickupTime: data.pickup_time ?? "",
    shipmentsCount: data.shipments_count ?? 0,
    courierOrderId: data.courier_order ?? null,
  };
}

function errorToLegacyCourierResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof FulfillmentProviderError) {
    return {
      status: 502,
      body: {
        error: error.providerMessage,
        error_code: CARRIER_PROVIDER_ERROR_CODE,
        provider_error: {
          operator_message: error.operatorMessage,
          retryable: error.retryable,
          support_code: error.supportCode,
          ...error.details,
        },
      },
    };
  }
  if (error instanceof FulfillmentPreflightError) {
    return {
      status: 400,
      body: {
        error: error.message,
        error_code: typeof error.details.errorCode === "string" ? error.details.errorCode : undefined,
      },
    };
  }
  return {
    status: 400,
    body: { error: error instanceof Error ? error.message : `${CARRIER_DISPLAY_NAME} request failed` },
  };
}

function mapLegacyCarrierError(
  error: unknown,
  code: string | undefined,
  providerError?: LegacyPickupResponse["provider_error"],
): Error {
  const message = sanitizeCarrierProviderMessage(error);
  if (code === CARRIER_PROVIDER_ERROR_CODE) {
    const operatorMessage = sanitizeCarrierProviderMessage(
      providerError?.operator_message ?? providerError?.operatorMessage ?? message,
    );
    return new FulfillmentProviderError(message, {
      operatorMessage,
      retryable: providerError?.retryable ?? true,
      supportCode: providerError?.support_code ?? providerError?.supportCode ?? null,
      details: providerErrorDetails(providerError),
    });
  }
  return new FulfillmentPreflightError(message);
}

function providerErrorDetails(
  providerError: LegacyPickupResponse["provider_error"] | undefined,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const reason = providerError?.reason;
  const blockingShipmentId = providerError?.blocking_shipment_id ?? providerError?.blockingShipmentId;
  if (reason === "already_booked") details.reason = reason;
  if (blockingShipmentId) details.blockingShipmentId = sanitizeCarrierProviderMessage(blockingShipmentId);
  return details;
}

function sanitizeCarrierProviderMessage(error: unknown): string {
  const stripped = String(error ?? `${CARRIER_DISPLAY_NAME} request failed`)
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(password|pass|username|login)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (stripped || `${CARRIER_DISPLAY_NAME} request failed`).slice(0, 300);
}

export const runDhlCourier = runCarrierPickup;
export const mapLegacyBookDhlCourierResponse = mapLegacyPickupResponse;
export const mapLegacyDhlError = mapLegacyCarrierError;
