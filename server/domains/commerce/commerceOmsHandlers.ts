import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceOrderDetailRequestSchema,
  adminCommerceOrderDetailResponseSchema,
  adminCommerceOrderHoldRequestSchema,
  adminCommerceOrderHoldResponseSchema,
  adminCommerceOrderNoteRequestSchema,
  adminCommerceOrderNoteResponseSchema,
  adminCommerceOrderReleaseHoldRequestSchema,
  adminCommerceOrderUpdateShippingAddressRequestSchema,
  adminCommerceOrderUpdateShippingAddressResponseSchema,
  adminCommerceOrdersListRequestSchema,
  adminCommerceOrdersListResponseSchema,
} from "../../../src/domains/commerce/omsContracts.js";
import { CommerceOmsConflictError, type CommerceOmsHoldPort, type CommerceOmsReadPort } from "../../../src/domains/commerce/omsPorts.js";
import { applyOmsAgentCustomerReadGate, type OmsAgentReadGovernance } from "../../_lib/admin-domain/customerReadGovernance.js";

export type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string; isMachineActor?: boolean };

export interface BaseDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
}

export function createAdminCommerceOrdersListHandler({
  authorizeAdmin,
  omsPort,
  governance,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsReadPort, "listOrders">;
  governance?: OmsAgentReadGovernance;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "POST") return sendMethodNotAllowed(res, ["GET", "POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;

    const rawRequest = req.method === "GET" ? req.query ?? {} : req.body ?? {};
    const request = adminCommerceOrdersListRequestSchema.safeParse(rawRequest);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce orders request", {
        details: request.error.flatten(),
      });
      return;
    }

    // Wave 7a: gate the machine actor; the human admin OMS UI is unaffected.
    const gate = applyOmsAgentCustomerReadGate({
      authorization: auth,
      governance,
      res,
      route: "/api/bff/admin/commerce/orders",
      query: auditSafeListQuery(request.data),
    });
    if (gate.blocked) return;

    try {
      const result = await omsPort.listOrders(request.data);
      const response = adminCommerceOrdersListResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce orders returned invalid response");
        return;
      }
      await gate.audit(response.data.orders.flatMap((o) => (o.clientId ? [o.clientId] : [])));
      sendBffSuccess(res, gate.maskOrders(response.data));
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce orders read failed");
    }
  };
}

function auditSafeListQuery(request: Record<string, unknown>): Record<string, unknown> {
  const { search, ...safe } = request;
  return search ? { ...safe, search: "[redacted]" } : safe;
}

export function createAdminCommerceOrderDetailHandler({
  authorizeAdmin,
  omsPort,
  governance,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsReadPort, "getOrderDetail">;
  governance?: OmsAgentReadGovernance;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;

    const request = adminCommerceOrderDetailRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce order detail request", {
        details: request.error.flatten(),
      });
      return;
    }

    // Wave 7a: gate the machine actor. Detail returns FULL PII (gated + audited).
    const gate = applyOmsAgentCustomerReadGate({
      authorization: auth,
      governance,
      res,
      route: "/api/bff/admin/commerce/orders/detail",
      query: { ...request.data },
    });
    if (gate.blocked) return;

    try {
      const result = await omsPort.getOrderDetail(request.data);
      if (!result) {
        sendBffError(res, "NOT_FOUND", "Commerce order not found");
        return;
      }
      const response = adminCommerceOrderDetailResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce order detail returned invalid response");
        return;
      }
      await gate.audit(response.data.order.clientId ? [response.data.order.clientId] : []);
      const masked = gate.maskOrders({ orders: [response.data.order] });
      sendBffSuccess(res, { ...response.data, order: masked.orders[0] });
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce order detail failed");
    }
  };
}

export function createAdminCommerceOrderHoldHandler({
  authorizeAdmin,
  omsPort,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "createHold">;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    const request = adminCommerceOrderHoldRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce order hold request", {
        details: request.error.flatten(),
      });
      return;
    }

    await sendHoldResponse(res, () => omsPort.createHold({ ...request.data, actorUserId: auth.userId }));
  };
}

export function createAdminCommerceOrderReleaseHoldHandler({
  authorizeAdmin,
  omsPort,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "releaseHold">;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    const request = adminCommerceOrderReleaseHoldRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce order release request", {
        details: request.error.flatten(),
      });
      return;
    }

    await sendHoldResponse(res, () => omsPort.releaseHold({ ...request.data, actorUserId: auth.userId }));
  };
}

export function createAdminCommerceOrderNoteHandler({
  authorizeAdmin,
  omsPort,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "addNote">;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    const request = adminCommerceOrderNoteRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce order note request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await omsPort.addNote({ ...request.data, actorUserId: auth.userId });
      const response = adminCommerceOrderNoteResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce note mutation returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce note mutation failed");
    }
  };
}

export function createAdminCommerceOrderUpdateShippingAddressHandler({
  authorizeAdmin,
  omsPort,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "updateShippingAddress">;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    const request = adminCommerceOrderUpdateShippingAddressRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce order shipping address request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await omsPort.updateShippingAddress({ ...request.data, actorUserId: auth.userId });
      const response = adminCommerceOrderUpdateShippingAddressResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce shipping address mutation returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce shipping address mutation failed");
    }
  };
}

export async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>,
): Promise<{ ok: true; userId: string; isMachineActor?: boolean } | null> {
  try {
    const authorization = await authorizeAdmin(req);
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return null;
    }
    return { ok: true, userId: authorization.userId, isMachineActor: authorization.isMachineActor };
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return null;
  }
}

async function sendHoldResponse(
  res: VercelResponse,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await action();
    const response = adminCommerceOrderHoldResponseSchema.safeParse(result);
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Admin commerce hold mutation returned invalid response");
      return;
    }
    sendBffSuccess(res, response.data);
  } catch (error) {
    if (error instanceof CommerceOmsConflictError) {
      sendBffError(res, "CONFLICT", error.message, { details: error.details });
      return;
    }
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce hold mutation failed");
  }
}
