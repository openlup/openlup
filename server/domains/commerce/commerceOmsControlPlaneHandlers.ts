/**
 * The `?view=control_plane_v1` read handlers. Unlike the V0 handlers in
 * `commerceOmsHandlers.ts`, these deliberately take NO `governance` dependency and
 * do not run `applyOmsAgentCustomerReadGate`: `commerce.oms_control_plane.v1`
 * carries no customer identity, so the gate would audit a `customer_read` of zero
 * customers and mask a field the strict contract forbids — and the portable
 * `node-postgres` branch of this same contract has neither an actor kind nor an
 * audit client to run it with. The exemption holds only while the projection stays
 * customer-free. Reasoning + precondition: docs/BFF_CONTRACTS.md, Admin Commerce;
 * pinned in `omsControlPlaneReadGovernance.test.ts`.
 */
import {
  omsControlPlaneDetailRequestSchema,
  omsControlPlaneDetailResponseSchema,
  omsControlPlaneListRequestSchema,
  omsControlPlaneListResponseSchema,
  type CommerceOmsControlPlanePort,
} from "../../../src/domains/commerce/omsControlPlane.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminAuthResult } from "./commerceOmsHandlers.js";

type Deps = {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  port: CommerceOmsControlPlanePort;
};

export function createCommerceOmsControlPlaneListHandler({ authorizeAdmin, port }: Deps) {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!await authorize(req, res, authorizeAdmin)) return;
    const request = omsControlPlaneListRequestSchema.safeParse(req.query ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid OMS control-plane list request", { details: request.error.flatten() });
      return;
    }
    try {
      const result = omsControlPlaneListResponseSchema.parse(await port.listOrders(request.data));
      sendBffSuccess(res, result);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "OMS control-plane list is unavailable");
    }
  };
}

export function createCommerceOmsControlPlaneDetailHandler({ authorizeAdmin, port }: Deps) {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!await authorize(req, res, authorizeAdmin)) return;
    const request = omsControlPlaneDetailRequestSchema.safeParse(req.query ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid OMS control-plane detail request", { details: request.error.flatten() });
      return;
    }
    try {
      const result = await port.getOrderDetail(request.data);
      if (!result) return sendBffError(res, "NOT_FOUND", "Commerce order not found");
      sendBffSuccess(res, omsControlPlaneDetailResponseSchema.parse(result));
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "OMS control-plane detail is unavailable");
    }
  };
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: Deps["authorizeAdmin"],
): Promise<boolean> {
  const result = await authorizeAdmin(req);
  if (result.ok === true) return true;
  sendBffError(res, result.code, result.message);
  return false;
}
