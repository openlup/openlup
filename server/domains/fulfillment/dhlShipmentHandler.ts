import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  bookDhlCourierRequestSchema,
  bookDhlCourierResponseSchema,
  clearDhlShipmentStateRequestSchema,
  clearDhlShipmentStateResponseSchema,
  createDhlShipmentRequestSchema,
  createDhlShipmentResponseSchema,
  getDhlLabelRequestSchema,
  getDhlLabelResponseSchema,
  mergeDhlLabelsRequestSchema,
  mergeDhlLabelsResponseSchema,
  repairDhlCourierPickupRequestSchema,
  repairDhlCourierPickupResponseSchema,
} from "../../../src/domains/fulfillment/contracts.js";
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
  type FulfillmentDhlShipmentPort,
} from "../../../src/domains/fulfillment/ports.js";

export interface FulfillmentDhlShipmentHandlerDeps {
  shipmentPort: FulfillmentDhlShipmentPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export const createFulfillmentDhlCreateShipmentHandler = createDhlPostHandler({
  requestSchema: createDhlShipmentRequestSchema,
  responseSchema: createDhlShipmentResponseSchema,
  invalidRequestMessage: "Invalid DHL create shipment request",
  invalidResponseMessage: "DHL create shipment returned invalid response",
  failureMessage: "DHL create shipment failed",
  execute: (port, request) => port.createDhlShipment(request),
  retireNewIntake: true,
});

export const createFulfillmentDhlLabelHandler = createDhlPostHandler({
  requestSchema: getDhlLabelRequestSchema,
  responseSchema: getDhlLabelResponseSchema,
  invalidRequestMessage: "Invalid DHL label request",
  invalidResponseMessage: "DHL label returned invalid response",
  failureMessage: "DHL label fetch failed",
  execute: (port, request) => port.getDhlLabel(request),
});

export const createFulfillmentDhlMergeLabelsHandler = createDhlPostHandler({
  requestSchema: mergeDhlLabelsRequestSchema,
  responseSchema: mergeDhlLabelsResponseSchema,
  invalidRequestMessage: "Invalid DHL merge labels request",
  invalidResponseMessage: "DHL merge labels returned invalid response",
  failureMessage: "DHL merge labels failed",
  execute: (port, request) => port.mergeDhlLabels(request),
});

export const createFulfillmentDhlBookCourierHandler = createDhlPostHandler({
  requestSchema: bookDhlCourierRequestSchema,
  responseSchema: bookDhlCourierResponseSchema,
  invalidRequestMessage: "Invalid DHL book courier request",
  invalidResponseMessage: "DHL book courier returned invalid response",
  failureMessage: "DHL book courier failed",
  execute: (port, request) => port.bookDhlCourier(request),
  retireNewIntake: true,
});

export const createFulfillmentDhlRepairCourierPickupHandler = createDhlPostHandler({
  requestSchema: repairDhlCourierPickupRequestSchema,
  responseSchema: repairDhlCourierPickupResponseSchema,
  invalidRequestMessage: "Invalid DHL courier pickup repair request",
  invalidResponseMessage: "DHL courier pickup repair returned invalid response",
  failureMessage: "DHL courier pickup repair failed",
  execute: (port, request) => port.repairDhlCourierPickup(request),
  retireRequest: isRetiredDhlRepairMutation,
});

export function isRetiredDhlRepairMutation(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const request = body as { mode?: unknown; sendEmails?: unknown };
  return request.mode !== "dry_run" || request.sendEmails !== false;
}

export const createFulfillmentDhlClearShipmentStateHandler = createDhlPostHandler({
  requestSchema: clearDhlShipmentStateRequestSchema,
  responseSchema: clearDhlShipmentStateResponseSchema,
  invalidRequestMessage: "Invalid DHL clear shipment state request",
  invalidResponseMessage: "DHL clear shipment state returned invalid response",
  failureMessage: "DHL clear shipment state failed",
  execute: (port, request) => port.clearDhlShipmentState(request),
});

type SafeParser<T> = {
  safeParse: (input: unknown) =>
    | { success: true; data: T }
    | { success: false; error: { flatten: () => unknown } };
};

/**
 * Every admin DHL route is the same POST envelope: method check, admin auth,
 * request parse, one port call, response parse, BFF success. Only the two
 * schemas, the three messages, and the port method differ - so they are the
 * only things a route declares. Provider/preflight error mapping is shared and
 * identical for all six (see `sendDhlShipmentError`).
 */
function createDhlPostHandler<TRequest>({
  requestSchema,
  responseSchema,
  invalidRequestMessage,
  invalidResponseMessage,
  failureMessage,
  execute,
  retireNewIntake = false,
  retireRequest,
}: {
  requestSchema: SafeParser<TRequest>;
  responseSchema: SafeParser<unknown>;
  invalidRequestMessage: string;
  invalidResponseMessage: string;
  failureMessage: string;
  execute: (port: FulfillmentDhlShipmentPort, request: TRequest) => Promise<unknown>;
  retireNewIntake?: boolean;
  retireRequest?: (body: unknown) => boolean;
}) {
  return function createHandler(deps: FulfillmentDhlShipmentHandlerDeps) {
    return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, ["POST"]);
        return;
      }
      if (retireRequest?.(req.body)) {
        sendBffError(res, "NOT_FOUND", "DHL courier pickup mutation is retired", {
          details: { reason: "direct_dhl_repair_mutation_retired" },
        });
        return;
      }
      if (!(await authorize(req, res, deps.authorizeAdmin))) return;

      if (retireNewIntake) {
        sendBffError(res, "NOT_FOUND", "New standalone DHL fulfillment is retired", {
          details: { reason: "direct_dhl_new_intake_retired" },
        });
        return;
      }

      const request = requestSchema.safeParse(req.body);
      if (request.success === false) {
        sendBffError(res, "BAD_REQUEST", invalidRequestMessage, {
          details: request.error.flatten(),
        });
        return;
      }

      try {
        const result = await execute(deps.shipmentPort, request.data);
        const response = responseSchema.safeParse(result);
        if (response.success === false) {
          sendBffError(res, "INVALID_RESPONSE", invalidResponseMessage);
          return;
        }
        sendBffSuccess(res, response.data);
      } catch (error) {
        sendDhlShipmentError(res, error, failureMessage);
      }
    };
  };
}

function sendDhlShipmentError(
  res: VercelResponse,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof FulfillmentPreflightError) {
    sendBffError(res, "BAD_REQUEST", error.message, { details: error.details });
    return;
  }

  if (error instanceof FulfillmentProviderError) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", error.operatorMessage, {
      details: {
        provider: error.provider,
        operatorMessage: error.operatorMessage,
        retryable: error.retryable,
        supportCode: error.supportCode,
        ...error.details,
      },
    });
    return;
  }

  sendBffError(res, "UPSTREAM_UNAVAILABLE", fallbackMessage);
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>,
): Promise<boolean> {
  try {
    if (await authorizeAdmin(req)) return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }

  sendBffError(res, "UNAUTHORIZED", "Admin session required");
  return false;
}
