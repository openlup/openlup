import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceFulfillmentCancelRequestSchema,
  adminCommerceFulfillmentCreateRequestSchema,
  adminCommerceFulfillmentHandOffRequestSchema,
  adminCommerceFulfillmentMutationResponseSchema,
  adminCommerceFulfillmentOrderDetailRequestSchema,
  adminCommerceFulfillmentOrderDetailResponseSchema,
  adminCommerceFulfillmentOrdersListRequestSchema,
  adminCommerceFulfillmentOrdersListResponseSchema,
  adminCommerceFulfillmentRecordLabelRequestSchema,
  adminCommerceFulfillmentRecordProviderAttemptRequestSchema,
  adminCommerceFulfillmentTrackingEventRequestSchema,
} from "../../../src/domains/fulfillment/commerceFulfillmentContracts.js";
import {
  CommerceFulfillmentConflictError,
  type CommerceFulfillmentMutationPort,
  type CommerceFulfillmentReadPort,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";

type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string };

interface BaseDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
}

type PortRef<T> = T | (() => T);

export function createAdminCommerceFulfillmentOrdersListHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentReadPort, "listCommerceFulfillmentOrders">>;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = adminCommerceFulfillmentOrdersListRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce fulfillment orders request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const port = resolvePort(fulfillmentPort);
      const result = await port.listCommerceFulfillmentOrders(request.data);
      const response = adminCommerceFulfillmentOrdersListResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce fulfillment orders response invalid");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce fulfillment orders read failed");
    }
  };
}

export function createAdminCommerceFulfillmentOrderDetailHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentReadPort, "getCommerceFulfillmentOrderDetail">>;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = adminCommerceFulfillmentOrderDetailRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce fulfillment detail request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const port = resolvePort(fulfillmentPort);
      const result = await port.getCommerceFulfillmentOrderDetail(request.data);
      if (!result) {
        sendBffError(res, "NOT_FOUND", "Commerce fulfillment order not found");
        return;
      }
      const response = adminCommerceFulfillmentOrderDetailResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce fulfillment detail response invalid");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce fulfillment detail read failed");
    }
  };
}

export function createAdminCommerceFulfillmentCreateOrderHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "createCommerceFulfillmentOrder">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    requestSchema: adminCommerceFulfillmentCreateRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment create request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.createCommerceFulfillmentOrder({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentRecordProviderAttemptHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentProviderAttempt">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    requestSchema: adminCommerceFulfillmentRecordProviderAttemptRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment provider attempt request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.recordCommerceFulfillmentProviderAttempt({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentRecordLabelHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentLabel">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    requestSchema: adminCommerceFulfillmentRecordLabelRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment label request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.recordCommerceFulfillmentLabel({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentHandOffHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "handOffCommerceFulfillmentOrder">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    requestSchema: adminCommerceFulfillmentHandOffRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment handoff request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.handOffCommerceFulfillmentOrder({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentTrackingEventHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentTrackingEvent">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    requestSchema: adminCommerceFulfillmentTrackingEventRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment tracking event request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.recordCommerceFulfillmentTrackingEvent({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentCancelOrderHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "cancelCommerceFulfillmentOrder">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    requestSchema: adminCommerceFulfillmentCancelRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment cancel request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.cancelCommerceFulfillmentOrder({ ...request, actorUserId });
    },
  });
}

function resolvePort<T>(port: PortRef<T>): T {
  return typeof port === "function" ? (port as () => T)() : port;
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>,
): Promise<{ userId: string } | null> {
  try {
    const authorization = await authorizeAdmin(req);
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return null;
    }
    return { userId: authorization.userId };
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return null;
  }
}

function createMutationHandler<T>({
  authorizeAdmin,
  requestSchema,
  invalidMessage,
  execute,
}: BaseDeps & {
  requestSchema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } };
  invalidMessage: string;
  execute: (request: T, actorUserId: string) => Promise<unknown>;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    const request = requestSchema.safeParse(req.body ?? {});
    if (request.success === false) {
      sendBffError(res, "BAD_REQUEST", invalidMessage, { details: request.error.flatten() });
      return;
    }

    try {
      const result = await execute(request.data, auth.userId);
      const response = adminCommerceFulfillmentMutationResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce fulfillment mutation response invalid");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CommerceFulfillmentConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce fulfillment mutation failed", {
        details: { reason: "fulfillment_mutation_failed" },
      });
    }
  };
}
