import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerOrderDetailRequestSchema,
  customerOrderDetailResponseSchema,
  customerOrdersListRequestSchema,
  customerOrdersListResponseSchema,
} from "../../../src/domains/customers/accountV2Contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerOrdersPort } from "./ports.js";

export interface CustomerOrdersDeps {
  ordersPort: CustomerOrdersPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerOrdersListHandler({ ordersPort, authenticateUser }: CustomerOrdersDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const authentication = await authenticate(authenticateUser, req, res);
    if (!authentication) return;
    const parsed = customerOrdersListRequestSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer orders request", { details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await ordersPort.listOrders(authentication.userId, parsed.data);
      if (!result) return sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
      const response = customerOrdersListResponseSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Customer orders returned invalid response");
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer orders request failed");
    }
  };
}

export function createCustomerOrderDetailHandler({ ordersPort, authenticateUser }: CustomerOrdersDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const authentication = await authenticate(authenticateUser, req, res);
    if (!authentication) return;
    const parsed = customerOrderDetailRequestSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer order detail request", { details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await ordersPort.getOrderDetail(authentication.userId, parsed.data.orderId);
      if (!result) return sendBffError(res, "NOT_FOUND", "Customer order was not found");
      const response = customerOrderDetailResponseSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Customer order returned invalid response");
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer order detail request failed");
    }
  };
}

async function authenticate(
  authenticateUser: CustomerOrdersDeps["authenticateUser"],
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const authentication = await authenticateUser(req);
    if (authentication.ok === false) sendBffError(res, authentication.code, authentication.message);
    return authentication.ok ? authentication : null;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer authentication failed");
    return null;
  }
}
