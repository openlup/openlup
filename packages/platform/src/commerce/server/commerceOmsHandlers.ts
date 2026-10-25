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
} from "../oms/omsContracts.js";
import { CommerceOmsConflictError,type CommerceOmsHoldPort,type CommerceOmsReadPort } from "../oms/omsPorts.js";
import type { OmsHandlerDeps,OmsHandlerRequest,OmsHandlerResponder } from "./handlerSupport.js";
import { unprojectedOmsReadGate,type OmsAdminAuthResult as AdminAuthResult } from "./handlerSupport.js";

export type { OmsAdminAuthResult as AdminAuthResult } from "./handlerSupport.js";
export type BaseDeps<Response> = OmsHandlerDeps<Response>;

export function createAdminCommerceOrdersListHandler<Response>({
  authorizeAdmin,
  omsPort,
  readGate,
  listRequestSchema = adminCommerceOrdersListRequestSchema,
  listResponseSchema = adminCommerceOrdersListResponseSchema,
  detailResponseSchema = adminCommerceOrderDetailResponseSchema,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsReadPort, "listOrders">;

}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "GET" && req.method !== "POST") return respond.sendMethodNotAllowed(res, ["GET", "POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;

    const rawRequest = req.method === "GET" ? req.query ?? {} : req.body ?? {};
    const request = parseOmsRequest(res, respond, listRequestSchema, rawRequest, "Invalid admin commerce orders request");
    if (request === undefined) return;

    // Wave 7a: gate the machine actor; the human admin OMS UI is unaffected.
    const gate = readGate?.({
      authorization: auth,
      view: "list",
      query: auditSafeListQuery(request),
    }) ?? unprojectedOmsReadGate;
    if (gate.blocked) return;

    try {
      const result = await omsPort.listOrders(request);
      const response = listResponseSchema.safeParse(result);
      if (!response.success) {
        respond.sendBffError(res, "INVALID_RESPONSE", "Admin commerce orders returned invalid response");
        return;
      }
      await gate.audit(response.data.orders.flatMap((o) => (o.clientId ? [o.clientId] : [])));
      respond.sendBffSuccess(res, gate.maskOrders(response.data));
    } catch {
      respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce orders read failed");
    }
  };
}

function auditSafeListQuery(request: Record<string, unknown>): Record<string, unknown> {
  const { search, ...safe } = request;
  return search ? { ...safe, search: "[redacted]" } : safe;
}

export function createAdminCommerceOrderDetailHandler<Response>({
  authorizeAdmin,
  omsPort,
  readGate,
  listRequestSchema = adminCommerceOrdersListRequestSchema,
  listResponseSchema = adminCommerceOrdersListResponseSchema,
  detailResponseSchema = adminCommerceOrderDetailResponseSchema,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsReadPort, "getOrderDetail">;

}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "GET") return respond.sendMethodNotAllowed(res, ["GET"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;

    const request = parseOmsRequest(res, respond, adminCommerceOrderDetailRequestSchema, req.query, "Invalid admin commerce order detail request");
    if (request === undefined) return;

    // Wave 7a: gate the machine actor. Detail returns FULL PII (gated + audited).
    const gate = readGate?.({
      authorization: auth,
      view: "detail",
      query: { ...request },
    }) ?? unprojectedOmsReadGate;
    if (gate.blocked) return;

    try {
      const result = await omsPort.getOrderDetail(request);
      if (!result) {
        respond.sendBffError(res, "NOT_FOUND", "Commerce order not found");
        return;
      }
      const response = detailResponseSchema.safeParse(result);
      if (!response.success) {
        respond.sendBffError(res, "INVALID_RESPONSE", "Admin commerce order detail returned invalid response");
        return;
      }
      await gate.audit(response.data.order.clientId ? [response.data.order.clientId] : []);
      const masked = gate.maskOrders({ orders: [response.data.order] });
      respond.sendBffSuccess(res, { ...response.data, order: masked.orders[0] });
    } catch {
      respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce order detail failed");
    }
  };
}

export function createAdminCommerceOrderHoldHandler<Response>({
  authorizeAdmin,
  omsPort,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsHoldPort, "createHold">;
}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return respond.sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;
    const request = parseOmsRequest(res, respond, adminCommerceOrderHoldRequestSchema, req.body ?? {}, "Invalid admin commerce order hold request");
    if (request === undefined) return;

    await sendHoldResponse(res, respond, () => omsPort.createHold({ ...request, actorUserId: auth.userId }));
  };
}

export function createAdminCommerceOrderReleaseHoldHandler<Response>({
  authorizeAdmin,
  omsPort,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsHoldPort, "releaseHold">;
}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return respond.sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;
    const request = parseOmsRequest(res, respond, adminCommerceOrderReleaseHoldRequestSchema, req.body ?? {}, "Invalid admin commerce order release request");
    if (request === undefined) return;

    await sendHoldResponse(res, respond, () => omsPort.releaseHold({ ...request, actorUserId: auth.userId }));
  };
}

export function createAdminCommerceOrderNoteHandler<Response>({
  authorizeAdmin,
  omsPort,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsHoldPort, "addNote">;
}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return respond.sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;
    const request = parseOmsRequest(res, respond, adminCommerceOrderNoteRequestSchema, req.body ?? {}, "Invalid admin commerce order note request");
    if (request === undefined) return;

    await sendOmsMutationResponse(
      res,
      respond,
      () => omsPort.addNote({ ...request, actorUserId: auth.userId }),
      adminCommerceOrderNoteResponseSchema,
      "Admin commerce note mutation returned invalid response",
      "Admin commerce note mutation failed",
    );
  };
}

export function createAdminCommerceOrderUpdateShippingAddressHandler<Response>({
  authorizeAdmin,
  omsPort,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsHoldPort, "updateShippingAddress">;
}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return respond.sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;
    const request = parseOmsRequest(res, respond, adminCommerceOrderUpdateShippingAddressRequestSchema, req.body ?? {}, "Invalid admin commerce order shipping address request");
    if (request === undefined) return;

    await sendOmsMutationResponse(
      res,
      respond,
      () => omsPort.updateShippingAddress({ ...request, actorUserId: auth.userId }),
      adminCommerceOrderUpdateShippingAddressResponseSchema,
      "Admin commerce shipping address mutation returned invalid response",
      "Admin commerce shipping address mutation failed",
    );
  };
}

export async function authorize<Response>(
  req: OmsHandlerRequest,
  res: Response,
  authorizeAdmin: (req: OmsHandlerRequest) => Promise<AdminAuthResult>,
  respond: OmsHandlerResponder<Response>,
): Promise<{ ok: true; userId: string; isMachineActor?: boolean } | null> {
  try {
    const authorization = await authorizeAdmin(req);
    if (authorization.ok === false) {
      respond.sendBffError(res, authorization.code, authorization.message);
      return null;
    }
    return { ok: true, userId: authorization.userId, isMachineActor: authorization.isMachineActor };
  } catch {
    respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return null;
  }
}

function sendHoldResponse<Response>(res: Response, respond: OmsHandlerResponder<Response>, action: () => Promise<unknown>): Promise<void> {
  return sendOmsMutationResponse(
    res,
    respond,
    action,
    adminCommerceOrderHoldResponseSchema,
    "Admin commerce hold mutation returned invalid response",
    "Admin commerce hold mutation failed",
  );
}

// Returns the parsed request, or answers the 400 with the flattened details and returns undefined.
export function parseOmsRequest<Response, T>(
  res: Response,
  respond: OmsHandlerResponder<Response>,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } },
  input: unknown,
  message: string,
): T | undefined {
  const request = schema.safeParse(input);
  if (request.success === false) {
    respond.sendBffError(res, "BAD_REQUEST", message, { details: request.error.flatten() });
    return undefined;
  }
  return request.data;
}

// One OMS mutation answer: 502 on a refused or unaccepted result, 409 on a conflict, 503 on any other throw.
export async function sendOmsMutationResponse<Response, T>(
  res: Response,
  respond: OmsHandlerResponder<Response>,
  action: () => Promise<unknown>,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
  invalidMessage: string,
  failedMessage: string,
  accept: (data: T) => boolean = () => true,
): Promise<void> {
  try {
    const result = await action();
    const response = schema.safeParse(result);
    if (response.success === false || !accept(response.data)) {
      respond.sendBffError(res, "INVALID_RESPONSE", invalidMessage);
      return;
    }
    respond.sendBffSuccess(res, response.data);
  } catch (error) {
    if (error instanceof CommerceOmsConflictError) {
      respond.sendBffError(res, "CONFLICT", error.message, { details: error.details });
      return;
    }
    respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", failedMessage);
  }
}
