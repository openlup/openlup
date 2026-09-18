import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { applyOmsAgentCustomerReadGate, type OmsAgentReadGovernance } from "../../_lib/admin-domain/customerReadGovernance.js";
import {
  REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION,
  referenceJourneyOrderReadbackDetailResponseSchema,
  referenceJourneyOrderReadbackListResponseSchema,
  referenceJourneyOrderReadbackRequestSchema,
  type ReferenceJourneyOrderReadbackPort,
} from "../../../src/domains/commerce/referenceJourneyReadbackContracts.js";

type ActorOnlyDataPort = {
  asActor: <T>(
    claims: { sub: string; role: "authenticated" },
    work: (client: unknown) => Promise<T>,
  ) => Promise<T>;
};
type ServiceOnlyDataPort = {
  asService: <T>(work: (client: unknown) => Promise<T>) => Promise<T>;
};
type CustomerAuthorization =
  | { ok: true; userId: string; accessToken: string }
  | { ok: false; code: "UNAUTHORIZED"; message: string };
type OperatorAuthorization = { ok: true; userId: string; isMachineActor: boolean } | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN" | "UPSTREAM_UNAVAILABLE"; message: string };

export function createReferenceJourneyCustomerReadbackHandler(deps: {
  authorize: () => Promise<CustomerAuthorization>;
  actorPort: (accessToken: string) => ActorOnlyDataPort | null;
  readback: ReferenceJourneyOrderReadbackPort;
}) {
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    let authorization: CustomerAuthorization;
    try { authorization = await deps.authorize(); } catch { return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer authentication failed"); }
    if (authorization.ok === false) return sendBffError(res, authorization.code, authorization.message);
    const request = referenceJourneyOrderReadbackRequestSchema.safeParse(req.query ?? {});
    if (!request.success) return sendBffError(res, "BAD_REQUEST", "Invalid reference order readback request", { details: request.error.flatten() });
    const actorPort = deps.actorPort(authorization.accessToken);
    if (!actorPort) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Actor data access is unavailable");
    try {
      if (request.data.operation === "list") {
        const limit = request.data.limit;
        const result = await actorPort.asActor({ sub: authorization.userId, role: "authenticated" }, (gateway) => deps.readback.listCustomerOrders(gateway, authorization.userId, limit));
        if (!result) return sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        const response = referenceJourneyOrderReadbackListResponseSchema.safeParse({ contractVersion: REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION, orders: result });
        return response.success ? sendBffSuccess(res, response.data) : sendBffError(res, "INVALID_RESPONSE", "Reference order readback returned invalid response");
      }
      const orderId = request.data.orderId;
      const result = await actorPort.asActor({ sub: authorization.userId, role: "authenticated" }, (gateway) => deps.readback.getCustomerOrder(gateway, authorization.userId, orderId));
      if (!result) return sendBffError(res, "NOT_FOUND", "Reference order was not found");
      const response = referenceJourneyOrderReadbackDetailResponseSchema.safeParse({ contractVersion: REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION, order: result });
      return response.success ? sendBffSuccess(res, response.data) : sendBffError(res, "INVALID_RESPONSE", "Reference order readback returned invalid response");
    } catch { return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference order readback failed"); }
  };
}

export function createReferenceJourneyOperatorReadbackHandler(deps: {
  authorize: () => Promise<OperatorAuthorization>;
  servicePort: () => ServiceOnlyDataPort | null;
  governance: () => OmsAgentReadGovernance;
  readback: ReferenceJourneyOrderReadbackPort;
}) {
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    let authorization: OperatorAuthorization;
    try { authorization = await deps.authorize(); } catch { return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed"); }
    if (authorization.ok === false) return sendBffError(res, authorization.code, authorization.message);
    const gate = applyOmsAgentCustomerReadGate({ authorization, governance: deps.governance(), res, route: "/api/bff/reference-journey/operator/order-readback", query: { operation: "reference-order-readback" } });
    if (gate.blocked) return;
    const request = referenceJourneyOrderReadbackRequestSchema.safeParse(req.query ?? {});
    if (!request.success) return sendBffError(res, "BAD_REQUEST", "Invalid reference order readback request", { details: request.error.flatten() });
    const servicePort = deps.servicePort();
    if (!servicePort) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Operator data access is unavailable");
    try {
      if (request.data.operation === "list") {
        const limit = request.data.limit;
        const result = await servicePort.asService((gateway) => deps.readback.listOperatorOrders(gateway, limit));
        const response = referenceJourneyOrderReadbackListResponseSchema.safeParse({ contractVersion: REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION, orders: result.map(({ orderId }) => ({ orderId })) });
        if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Reference order readback returned invalid response");
        await gate.audit(result.flatMap((order) => order.clientId ? [order.clientId] : []));
        return sendBffSuccess(res, response.data);
      }
      const orderId = request.data.orderId;
      const result = await servicePort.asService((gateway) => deps.readback.getOperatorOrder(gateway, orderId));
      if (!result) return sendBffError(res, "NOT_FOUND", "Reference order was not found");
      const response = referenceJourneyOrderReadbackDetailResponseSchema.safeParse({ contractVersion: REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION, order: { orderId: result.orderId } });
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Reference order readback returned invalid response");
      await gate.audit(result.clientId ? [result.clientId] : []);
      return sendBffSuccess(res, response.data);
    } catch { return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference order readback failed"); }
  };
}
