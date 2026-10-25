import {
adminCommerceOrderMarkRefundedRequestSchema,
adminCommerceOrderMarkRefundedResponseSchema,
} from "../oms/omsContracts.js";
import type { CommerceOmsHoldPort } from "../oms/omsPorts.js";
import { authorize,parseOmsRequest,sendOmsMutationResponse,type BaseDeps } from "./commerceOmsHandlers.js";
import type { OmsHandlerRequest } from "./handlerSupport.js";

export function createAdminCommerceOrderMarkRefundedHandler<Response>({
  authorizeAdmin,
  omsPort,
  mutationsEnabled,
  respond,
}: BaseDeps<Response> & {
  omsPort: Pick<CommerceOmsHoldPort, "markRefunded">;
  mutationsEnabled: () => boolean;
}) {
  return async function handler(req: OmsHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return respond.sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;
    if (!mutationsEnabled()) {
      respond.sendBffError(res, "FORBIDDEN", "Commerce OMS refund mutations are not enabled");
      return;
    }

    const request = parseOmsRequest(res, respond, adminCommerceOrderMarkRefundedRequestSchema, req.body ?? {}, "Invalid admin commerce order mark-refunded request");
    if (request === undefined) return;

    await sendOmsMutationResponse(
      res,
      respond,
      () => omsPort.markRefunded({ ...request, actorUserId: auth.userId }),
      adminCommerceOrderMarkRefundedResponseSchema,
      "Admin commerce mark-refunded mutation returned invalid response",
      "Admin commerce mark-refunded mutation failed",
    );
  };
}
