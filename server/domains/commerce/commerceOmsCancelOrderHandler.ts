import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceOrderCancelRequestSchema,
  adminCommerceOrderMarkRefundedResponseSchema,
} from "../../../src/domains/commerce/omsContracts.js";
import { CommerceOmsConflictError, type CommerceOmsHoldPort } from "../../../src/domains/commerce/omsPorts.js";
import { authorize, type BaseDeps } from "./commerceOmsHandlers.js";

// This is deliberately not the fulfillment cancellation boundary. It only
// terminalizes an unpaid commerce order; the SQL RPC owns the state-machine and
// reservation-release side effect.
export function createAdminCommerceOrderCancelHandler({
  authorizeAdmin,
  omsPort,
  mutationsEnabled,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "cancelOrder">;
  mutationsEnabled: () => boolean;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    if (!mutationsEnabled()) {
      sendBffError(res, "FORBIDDEN", "Commerce OMS order cancellation is not enabled");
      return;
    }

    const request = adminCommerceOrderCancelRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce order cancellation request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await omsPort.cancelOrder({ ...request.data, actorUserId: auth.userId });
      const response = adminCommerceOrderMarkRefundedResponseSchema.safeParse(result);
      if (!response.success || response.data.status !== "cancelled") {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce order cancellation returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce order cancellation failed");
    }
  };
}
