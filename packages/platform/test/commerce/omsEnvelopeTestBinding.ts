import * as handlers from "../../src/commerce/server/commerceOmsHandlers.js";
import { createAdminCommerceOrderCancelHandler as cancel } from "../../src/commerce/server/commerceOmsCancelOrderHandler.js";
import { createAdminCommerceOrderMarkRefundedHandler as mark } from "../../src/commerce/server/commerceOmsMarkRefundedHandler.js";
import { createReplacementHandler, type TestResponse } from "./omsConformanceTestKit.js";
import type { OmsHandlerResponder } from "../../src/commerce/server/handlerSupport.js";
const status = { UNAUTHORIZED: 401, FORBIDDEN: 403, BAD_REQUEST: 400, INVALID_RESPONSE: 502, NOT_FOUND: 404, CONFLICT: 409, UPSTREAM_UNAVAILABLE: 503 };
function send(res: TestResponse, code: number, value: unknown) {
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.status(code); res.json(value);
}
const respond: OmsHandlerResponder<TestResponse> = {
  sendBffSuccess: (res, data) => send(res, 200, { ok: true, data }),
  sendBffError: (res, code, message, options) => send(res, status[code], { ok: false, error: { code, message, details: options?.details } }),
  sendMethodNotAllowed(res, methods) { res.setHeader("Allow", methods.join(", ")); send(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }); },
};
export const createAdminCommerceOrderHoldHandler = (deps: Omit<Parameters<typeof handlers.createAdminCommerceOrderHoldHandler<TestResponse>>[0], "respond">) => handlers.createAdminCommerceOrderHoldHandler({ ...deps, respond });
export const createAdminCommerceOrderNoteHandler = (deps: Omit<Parameters<typeof handlers.createAdminCommerceOrderNoteHandler<TestResponse>>[0], "respond">) => handlers.createAdminCommerceOrderNoteHandler({ ...deps, respond });
export const createAdminCommerceOrderReleaseHoldHandler = (deps: Omit<Parameters<typeof handlers.createAdminCommerceOrderReleaseHoldHandler<TestResponse>>[0], "respond">) => handlers.createAdminCommerceOrderReleaseHoldHandler({ ...deps, respond });
export const createAdminCommerceOrderUpdateShippingAddressHandler = (deps: Omit<Parameters<typeof handlers.createAdminCommerceOrderUpdateShippingAddressHandler<TestResponse>>[0], "respond">) => handlers.createAdminCommerceOrderUpdateShippingAddressHandler({ ...deps, respond });
export const createAdminCommerceOrderCancelHandler = (deps: Omit<Parameters<typeof cancel<TestResponse>>[0], "respond">) => cancel({ ...deps, respond });
export const createAdminCommerceOrderMarkRefundedHandler = (deps: Omit<Parameters<typeof mark<TestResponse>>[0], "respond">) => mark({ ...deps, respond });
export const createAdminCommerceOrderRequestReplacementShipmentHandler = (deps: Omit<Parameters<typeof createReplacementHandler>[0], "respond">) => createReplacementHandler({ ...deps, respond });
