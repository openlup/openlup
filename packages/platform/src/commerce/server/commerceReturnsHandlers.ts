// BFF handlers for the Commerce Returns R0 control plane:
//   - customer: POST /api/bff/commerce/returns/request  (bearer-authenticated)
//   - admin:    POST /api/bff/admin/returns/approve|reject
// Each validates with the returns port schemas and calls the service-role port,
// mapping RPC input/state errors (ERRCODE 22023) to 400s.

import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { z } from "zod";
import {
  returnApproveSchema,
  returnRejectSchema,
  returnRequestCreateSchema,
  type CommerceReturnsPort,
  type ReturnRequestCreateInput,
} from "../commerceReturnsPort.js";

type AdminAuthResult =
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL"; message: string };

// Local auth-result shape (structural match for the customers auth result) so the
// commerce domain stays free of a cross-domain import of customers internals.
type CustomerAuthResult =
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED"; message: string };

// RPC validation/state errors that map to a 400 (vs an unexpected 500).
const CLIENT_ERROR = /_invalid_input|_invalid_state|_not_found|_not_returnable|_quantity_exceeds_ordered|_line_not_in_order/;

function methodGuard(req: HttpRequest, res: HttpResponse, responder: BffResponder): boolean {
  const { sendBffError } = responder;
  if (req.method !== "POST") {
    sendBffError(res, "METHOD_NOT_ALLOWED", "Method not allowed", { status: 405 });
    return false;
  }
  return true;
}

function mapExecuteError(res: HttpResponse, error: unknown, responder: BffResponder): void {
  const { sendBffError } = responder;
  const message = error instanceof Error ? error.message : "return_operation_failed";
  if (CLIENT_ERROR.test(message)) {
    sendBffError(res, "BAD_REQUEST", "Return request rejected", { details: { reason: message } });
    return;
  }
  sendBffError(res, "INTERNAL", "Return operation failed");
}

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export function createCustomerReturnRequestHandler(deps: {
  responder: BffResponder;
  port: Pick<CommerceReturnsPort<string>, "createRequest">;
  requestSchema?: z.ZodType<ReturnRequestCreateInput<string>>;
  authenticateUser: () => Promise<CustomerAuthResult>;
  enabled: () => boolean;
}) {
  const { sendBffError, sendBffSuccess } = deps.responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (!methodGuard(req, res, deps.responder)) return;
    if (!deps.enabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Returns are not enabled", {
        details: { feature: "commerce_returns", featureFlag: "COMMERCE_RETURNS_ENABLED", reason: "feature_flag_disabled" },
      });
      return;
    }
    const auth = await deps.authenticateUser();
    if (!auth.ok) {
      sendBffError(res, "UNAUTHORIZED", "Sign in required to request a return");
      return;
    }
    const parsed = (deps.requestSchema ?? returnRequestCreateSchema).safeParse(req.body ?? {});
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid return request", { details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await deps.port.createRequest({ ...parsed.data, requestedBy: auth.userId });
      sendBffSuccess(res, result);
    } catch (error) {
      mapExecuteError(res, error, deps.responder);
    }
  };
}

function createAdminReturnHandler<T>(deps: {
  responder: BffResponder;
  authorizeAdmin: (req: HttpRequest) => Promise<AdminAuthResult>;
  requestSchema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } };
  invalidMessage: string;
  execute: (request: T, actorUserId: string) => Promise<unknown>;
}) {
  const { sendBffError, sendBffSuccess } = deps.responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (!methodGuard(req, res, deps.responder)) return;
    const auth = await deps.authorizeAdmin(req);
    if (auth.ok === false) {
      sendBffError(res, auth.code, auth.message);
      return;
    }
    const parsed = deps.requestSchema.safeParse(req.body ?? {});
    if (parsed.success === false) {
      sendBffError(res, "BAD_REQUEST", deps.invalidMessage, { details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await deps.execute(parsed.data, auth.userId);
      sendBffSuccess(res, result);
    } catch (error) {
      mapExecuteError(res, error, deps.responder);
    }
  };
}

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export function createAdminReturnApproveHandler(deps: {
  responder: BffResponder;
  authorizeAdmin: (req: HttpRequest) => Promise<AdminAuthResult>;
  port: Pick<CommerceReturnsPort, "approve">;
}) {
  return createAdminReturnHandler({
    responder: deps.responder,
    authorizeAdmin: deps.authorizeAdmin,
    requestSchema: returnApproveSchema,
    invalidMessage: "Invalid return approve request",
    execute: (request, actorUserId) => deps.port.approve({ ...request, actorUserId }),
  });
}

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export function createAdminReturnRejectHandler(deps: {
  responder: BffResponder;
  authorizeAdmin: (req: HttpRequest) => Promise<AdminAuthResult>;
  port: Pick<CommerceReturnsPort, "reject">;
}) {
  return createAdminReturnHandler({
    responder: deps.responder,
    authorizeAdmin: deps.authorizeAdmin,
    requestSchema: returnRejectSchema,
    invalidMessage: "Invalid return reject request",
    execute: (request, actorUserId) => deps.port.reject({ ...request, actorUserId }),
  });
}
