import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceOrderRequestReplacementShipmentRequestSchema,
  adminCommerceOrderRequestReplacementShipmentResponseSchema,
} from "../../../src/domains/commerce/omsContracts.js";
import { CommerceOmsConflictError, type CommerceOmsHoldPort } from "../../../src/domains/commerce/omsPorts.js";
import { authorize, type BaseDeps } from "./commerceOmsHandlers.js";

/**
 * The operator's replacement command. It lives beside `commerceOmsHandlers.ts`
 * rather than inside it for the same reason the unpaid-order cancellation does:
 * that module measured 282 against a cap of 320 and this handler is 46 lines, so
 * the choice was a new module or a cap raise on a file whose length is already the
 * thing the cap is protecting.
 *
 * What makes it worth reading: the refusals. `commerce_oms_request_replacement_shipment`
 * refuses by name in eighteen distinct ways -- five of them naming the hold reason
 * that blocked it -- and the adapter translates each into a closed `details.reason`
 * vocabulary. This handler passes exactly that through and adds nothing to it, so
 * the operator surface renders a sentence per refusal and no database text can
 * reach a screen. `releasedHoldIds` in the success body is the audit trail of the
 * one hold reason the command is allowed to clear.
 */
export function createAdminCommerceOrderRequestReplacementShipmentHandler({
  authorizeAdmin,
  omsPort,
}: BaseDeps & {
  omsPort: Pick<CommerceOmsHoldPort, "requestReplacementShipment">;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;

    const request = adminCommerceOrderRequestReplacementShipmentRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce replacement shipment request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await omsPort.requestReplacementShipment({ ...request.data, actorUserId: auth.userId });
      const response = adminCommerceOrderRequestReplacementShipmentResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce replacement shipment returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce replacement shipment failed");
    }
  };
}
