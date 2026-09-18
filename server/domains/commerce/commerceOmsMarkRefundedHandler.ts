import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceOrderMarkRefundedRequestSchema,
  adminCommerceOrderMarkRefundedResponseSchema,
} from "../../../src/domains/commerce/omsContracts.js";
import { CommerceOmsConflictError, type CommerceOmsHoldPort } from "../../../src/domains/commerce/omsPorts.js";
import { authorize, type BaseDeps } from "./commerceOmsHandlers.js";

export function createAdminCommerceOrderMarkRefundedHandler({
  authorizeAdmin,
  omsPort,
  mutationsEnabled,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "markRefunded">;
  mutationsEnabled: () => boolean;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    if (!mutationsEnabled()) {
      sendBffError(res, "FORBIDDEN", "Commerce OMS refund mutations are not enabled");
      return;
    }

    const request = adminCommerceOrderMarkRefundedRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce order mark-refunded request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await omsPort.markRefunded({ ...request.data, actorUserId: auth.userId });
      const response = adminCommerceOrderMarkRefundedResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce mark-refunded mutation returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce mark-refunded mutation failed");
    }
  };
}
