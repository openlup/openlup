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
} from "./handlerSchemas.js";
import type { FulfillmentOperatorMutationPort as CommerceFulfillmentMutationPort } from './contracts/operator.js';
import type { FulfillmentCommerceReadPort as CommerceFulfillmentReadPort } from './contracts/read.js';
import { CommerceFulfillmentConflictError, authorize, isNativeUnsupported, type BaseDeps, type FulfillmentHandlerRequest } from './handlerSupport.js';
type PortRef<T> = T | (() => T);

export function createAdminCommerceFulfillmentOrdersListHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentReadPort, "listCommerceFulfillmentOrders">>;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: FulfillmentHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin, respond))) return;

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
      if (isNativeUnsupported(result)) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Native fulfillment operation unsupported", { details: result });
        return;
      }
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

export function createAdminCommerceFulfillmentOrderDetailHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentReadPort, "getCommerceFulfillmentOrderDetail">>;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: FulfillmentHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin, respond))) return;

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
      if (isNativeUnsupported(result)) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Native fulfillment operation unsupported", { details: result });
        return;
      }
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

export function createAdminCommerceFulfillmentCreateOrderHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "createCommerceFulfillmentOrder">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    respond,
    requestSchema: adminCommerceFulfillmentCreateRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment create request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.createCommerceFulfillmentOrder({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentRecordProviderAttemptHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentProviderAttempt">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    respond,
    requestSchema: adminCommerceFulfillmentRecordProviderAttemptRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment provider attempt request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.recordCommerceFulfillmentProviderAttempt({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentRecordLabelHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentLabel">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    respond,
    requestSchema: adminCommerceFulfillmentRecordLabelRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment label request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.recordCommerceFulfillmentLabel({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentHandOffHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "handOffCommerceFulfillmentOrder">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    respond,
    requestSchema: adminCommerceFulfillmentHandOffRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment handoff request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.handOffCommerceFulfillmentOrder({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentTrackingEventHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentTrackingEvent">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    respond,
    requestSchema: adminCommerceFulfillmentTrackingEventRequestSchema,
    invalidMessage: "Invalid admin commerce fulfillment tracking event request",
    execute: (request, actorUserId) => {
      const port = resolvePort(fulfillmentPort);
      return port.recordCommerceFulfillmentTrackingEvent({ ...request, actorUserId });
    },
  });
}

export function createAdminCommerceFulfillmentCancelOrderHandler<Response>({
  authorizeAdmin,
  respond,
  fulfillmentPort,
}: BaseDeps<Response> & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "cancelCommerceFulfillmentOrder">>;
}) {
  return createMutationHandler({
    authorizeAdmin,
    respond,
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

function createMutationHandler<T, Response>({
  authorizeAdmin,
  respond,
  requestSchema,
  invalidMessage,
  execute,
}: BaseDeps<Response> & {
  requestSchema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } };
  invalidMessage: string;
  execute: (request: T, actorUserId: string) => Promise<unknown>;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: FulfillmentHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;
    const request = requestSchema.safeParse(req.body ?? {});
    if (request.success === false) {
      sendBffError(res, "BAD_REQUEST", invalidMessage, { details: request.error.flatten() });
      return;
    }

    try {
      const result = await execute(request.data, auth.userId);
      if (isNativeUnsupported(result)) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Native fulfillment operation unsupported", { details: result });
        return;
      }
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
