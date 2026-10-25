import {
adminCommerceOrderCancelRequestSchema,
adminCommerceOrderMarkRefundedResponseSchema,
} from "../oms/omsContracts.js";
import type { CommerceOmsHoldPort } from "../oms/omsPorts.js";
import { authorize,parseOmsRequest,sendOmsMutationResponse,type BaseDeps } from "./commerceOmsHandlers.js";
import type { OmsHandlerRequest } from "./handlerSupport.js";

// This is deliberately not the fulfillment cancellation boundary. It only
// terminalizes an unpaid commerce order; the SQL RPC owns the state-machine and
// reservation-release side effect.
export function createAdminCommerceOrderCancelHandler<Response>({
  authorizeAdmin,
  omsPort,
  mutationsEnabled,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsHoldPort, "cancelOrder">;
  mutationsEnabled: () => boolean;
}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return respond.sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;
    if (!mutationsEnabled()) {
      respond.sendBffError(res, "FORBIDDEN", "Commerce OMS order cancellation is not enabled");
      return;
    }

    const request = parseOmsRequest(res, respond, adminCommerceOrderCancelRequestSchema, req.body ?? {}, "Invalid admin commerce order cancellation request");
    if (request === undefined) return;

    await sendOmsMutationResponse(
      res,
      respond,
      () => omsPort.cancelOrder({ ...request, actorUserId: auth.userId }),
      adminCommerceOrderMarkRefundedResponseSchema,
      "Admin commerce order cancellation returned invalid response",
      "Admin commerce order cancellation failed",
      (data) => data.status === "cancelled",
    );
  };
}
