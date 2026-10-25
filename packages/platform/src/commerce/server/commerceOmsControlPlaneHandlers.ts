import type { OmsHandlerDeps,OmsHandlerRequest,OmsHandlerResponder } from "./handlerSupport.js";
/**
 * The `?view=control_plane_v1` read handlers. Unlike the V0 handlers in
 * `commerceOmsHandlers.ts`, these deliberately take NO `governance` dependency and
 * do not run `applyOmsAgentCustomerReadGate`: `commerce.oms_control_plane.v1`
 * carries no customer identity, so the gate would audit a `customer_read` of zero
 * customers and mask a field the strict contract forbids — and the portable
 * `node-postgres` branch of this same contract has neither an actor kind nor an
 * audit client to run it with. The exemption holds only while the projection stays
 * customer-free, a precondition pinned in `omsControlPlaneReadGovernance.test.ts`.
 */
import {
omsControlPlaneDetailRequestSchema,
omsControlPlaneDetailResponseSchema,
omsControlPlaneListRequestSchema,
omsControlPlaneListResponseSchema,
type CommerceOmsControlPlanePort,
} from "../oms/omsControlPlane.js";

type Deps<Response> = OmsHandlerDeps<Response> & {
  port: CommerceOmsControlPlanePort;
};

export function createCommerceOmsControlPlaneListHandler<Response>({ authorizeAdmin, port, respond }: Deps<Response>) {
  return async (req: OmsHandlerRequest, res: Response): Promise<void> => {
    if (req.method !== "GET") return respond.sendMethodNotAllowed(res, ["GET"]);
    if (!await authorize(req, res, authorizeAdmin, respond)) return;
    const request = omsControlPlaneListRequestSchema.safeParse(req.query ?? {});
    if (!request.success) {
      respond.sendBffError(res, "BAD_REQUEST", "Invalid OMS control-plane list request", { details: request.error.flatten() });
      return;
    }
    try {
      const result = omsControlPlaneListResponseSchema.parse(await port.listOrders(request.data));
      respond.sendBffSuccess(res, result);
    } catch {
      respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "OMS control-plane list is unavailable");
    }
  };
}

export function createCommerceOmsControlPlaneDetailHandler<Response>({ authorizeAdmin, port, respond }: Deps<Response>) {
  return async (req: OmsHandlerRequest, res: Response): Promise<void> => {
    if (req.method !== "GET") return respond.sendMethodNotAllowed(res, ["GET"]);
    if (!await authorize(req, res, authorizeAdmin, respond)) return;
    const request = omsControlPlaneDetailRequestSchema.safeParse(req.query ?? {});
    if (!request.success) {
      respond.sendBffError(res, "BAD_REQUEST", "Invalid OMS control-plane detail request", { details: request.error.flatten() });
      return;
    }
    try {
      const result = await port.getOrderDetail(request.data);
      if (!result) return respond.sendBffError(res, "NOT_FOUND", "Commerce order not found");
      respond.sendBffSuccess(res, omsControlPlaneDetailResponseSchema.parse(result));
    } catch {
      respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "OMS control-plane detail is unavailable");
    }
  };
}

async function authorize<Response>(
  req: OmsHandlerRequest,
  res: Response,
  authorizeAdmin: Deps<Response>["authorizeAdmin"],
  respond: OmsHandlerResponder<Response>,
): Promise<boolean> {
  const result = await authorizeAdmin(req);
  if (result.ok === true) return true;
  respond.sendBffError(res, result.code, result.message);
  return false;
}
