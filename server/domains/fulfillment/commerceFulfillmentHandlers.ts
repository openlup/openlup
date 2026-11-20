import {
  CommerceFulfillmentConflictError as PlatformCommerceFulfillmentConflictError,
  createAdminCommerceFulfillmentCancelOrderHandler as createPlatformCancelOrderHandler,
  createAdminCommerceFulfillmentCreateOrderHandler as createPlatformCreateOrderHandler,
  createAdminCommerceFulfillmentHandOffHandler as createPlatformHandOffHandler,
  createAdminCommerceFulfillmentOrderDetailHandler as createPlatformOrderDetailHandler,
  createAdminCommerceFulfillmentOrdersListHandler as createPlatformOrdersListHandler,
  createAdminCommerceFulfillmentRecordLabelHandler as createPlatformRecordLabelHandler,
  createAdminCommerceFulfillmentRecordProviderAttemptHandler as createPlatformRecordProviderAttemptHandler,
  createAdminCommerceFulfillmentTrackingEventHandler as createPlatformTrackingEventHandler,
} from "@openlup/platform/fulfillment";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceFulfillmentMutationResponseSchema,
  adminCommerceFulfillmentOrderDetailResponseSchema,
  adminCommerceFulfillmentOrdersListResponseSchema,
} from "../../../src/domains/fulfillment/contracts.js";
import {
  CommerceFulfillmentConflictError,
  type CommerceFulfillmentMutationPort,
  type CommerceFulfillmentReadPort,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";

export { CommerceFulfillmentConflictError };

type PortRef<T> = T | (() => T);

interface BaseDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

const respond = { sendBffError, sendBffSuccess, sendMethodNotAllowed };
const responseSchemas = {
  list: adminCommerceFulfillmentOrdersListResponseSchema,
  detail: adminCommerceFulfillmentOrderDetailResponseSchema,
  mutation: adminCommerceFulfillmentMutationResponseSchema,
};

function wrap(handler: (req: { method?: string; query: Record<string, string | string[] | undefined>; body?: unknown }, res: VercelResponse) => Promise<void>) {
  return (req: VercelRequest, res: VercelResponse): Promise<void> => handler(req, res);
}

function adaptConflictPort<T extends Record<string, (...args: never[]) => Promise<unknown>>>(
  portRef: PortRef<T>,
  method: keyof T & string,
): () => T {
  return () => {
    const resolved = typeof portRef === "function" ? portRef() : portRef;
    return {
      ...resolved,
      [method]: async (...args: never[]) => {
        try {
          return await resolved[method](...args);
        } catch (error) {
          if (error instanceof CommerceFulfillmentConflictError) {
            throw new PlatformCommerceFulfillmentConflictError(error.message, error.details);
          }
          throw error;
        }
      },
    };
  };
}

export function createAdminCommerceFulfillmentOrdersListHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentReadPort, "listCommerceFulfillmentOrders">>;
}) {
  return wrap(createPlatformOrdersListHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort,
    responseSchemas,
  }));
}

export function createAdminCommerceFulfillmentOrderDetailHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentReadPort, "getCommerceFulfillmentOrder">>;
}) {
  return wrap(createPlatformOrderDetailHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort,
    responseSchemas,
  }));
}

export function createAdminCommerceFulfillmentCreateOrderHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "createCommerceFulfillmentOrder">>;
}) {
  return wrap(createPlatformCreateOrderHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort: adaptConflictPort(fulfillmentPort, "createCommerceFulfillmentOrder"),
    responseSchemas,
  }));
}

export function createAdminCommerceFulfillmentRecordProviderAttemptHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentProviderAttempt">>;
}) {
  return wrap(createPlatformRecordProviderAttemptHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort: adaptConflictPort(fulfillmentPort, "recordCommerceFulfillmentProviderAttempt"),
    responseSchemas,
  }));
}

export function createAdminCommerceFulfillmentRecordLabelHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentLabel">>;
}) {
  return wrap(createPlatformRecordLabelHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort: adaptConflictPort(fulfillmentPort, "recordCommerceFulfillmentLabel"),
    responseSchemas,
  }));
}

export function createAdminCommerceFulfillmentHandOffHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "handOffCommerceFulfillmentOrder">>;
}) {
  return wrap(createPlatformHandOffHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort: adaptConflictPort(fulfillmentPort, "handOffCommerceFulfillmentOrder"),
    responseSchemas,
  }));
}

export function createAdminCommerceFulfillmentTrackingEventHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "recordCommerceFulfillmentTrackingEvent">>;
}) {
  return wrap(createPlatformTrackingEventHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort: adaptConflictPort(fulfillmentPort, "recordCommerceFulfillmentTrackingEvent"),
    responseSchemas,
  }));
}

export function createAdminCommerceFulfillmentCancelOrderHandler({
  authorizeAdmin,
  fulfillmentPort,
}: BaseDeps & {
  fulfillmentPort: PortRef<Pick<CommerceFulfillmentMutationPort, "cancelCommerceFulfillmentOrder">>;
}) {
  return wrap(createPlatformCancelOrderHandler<VercelResponse>({
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    respond,
    fulfillmentPort: adaptConflictPort(fulfillmentPort, "cancelCommerceFulfillmentOrder"),
    responseSchemas,
  }));
}
