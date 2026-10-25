import { vi } from "vitest";
import { CommerceOmsConflictError } from "../../src/commerce/oms/omsPorts.js";
import { createAdminCommerceOrderRequestReplacementShipmentHandler as createReplacement, CommerceFulfillmentConflictError } from "../../src/fulfillment/index.js";
import type { CommerceOmsHoldPort } from "../../src/commerce/oms/omsPorts.js";
import type { FulfillmentReplacementPort } from "../../src/fulfillment/contracts/index.js";
import type { OmsHandlerDeps, OmsHandlerResponder } from "../../src/commerce/server/handlerSupport.js";
export function createResponse() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}
export type TestResponse = ReturnType<typeof createResponse>;
export const respond: OmsHandlerResponder<TestResponse> = {
  sendMethodNotAllowed(res) { res.status(405); res.json({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }); },
  sendBffSuccess(res, data) { res.status(200); res.json({ ok: true, data }); },
  sendBffError(res, code, message, options) {
    const statuses = { UNAUTHORIZED: 401, FORBIDDEN: 403, BAD_REQUEST: 400, INVALID_RESPONSE: 502, NOT_FOUND: 404, CONFLICT: 409, UPSTREAM_UNAVAILABLE: 503 };
    res.status(statuses[code]); res.json({ ok: false, error: { code, message, ...(options ?? {}) } });
  },
};
export const request = (method: string, body?: unknown) => ({ method, body, query: {} });
/** The same nominal-error translation used by the reference M08 binding. */
export function createReplacementHandler(deps: OmsHandlerDeps<TestResponse> & { omsPort: Pick<CommerceOmsHoldPort, "requestReplacementShipment"> }) {
  const port: FulfillmentReplacementPort = { async requestReplacementShipment(input) {
    try { return await deps.omsPort.requestReplacementShipment(input) as Awaited<ReturnType<FulfillmentReplacementPort["requestReplacementShipment"]>>; }
    catch (error) { if (error instanceof CommerceOmsConflictError) throw new CommerceFulfillmentConflictError(error.message, error.details); throw error; }
  } };
  return createReplacement({ authorizeAdmin: deps.authorizeAdmin, respond: deps.respond, omsPort: port });
}
