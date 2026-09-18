import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceRenewalExceptionsRequestSchema,
  adminCommerceRenewalExceptionsResponseSchema,
  type AdminCommerceRenewalExceptionEvidenceSnapshot,
} from "../../../src/domains/commerce/renewalExceptionContracts.js";
import { buildAdminCommerceRenewalExceptionsResponse } from "../../../src/domains/commerce/renewalExceptionReadModel.js";

type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string; isMachineActor?: boolean };

export function createAdminCommerceRenewalExceptionsHandler({
  authorizeAdmin,
  renewalExceptionPort,
  now = () => new Date(),
}: {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  renewalExceptionPort: {
    // `options` is declared but ports that ignore the window stay assignable,
    // so no existing composer had to learn about it to keep compiling.
    collectEvidence(now: Date, options: { windowDays: number }): Promise<AdminCommerceRenewalExceptionEvidenceSnapshot>;
  };
  now?: () => Date;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorizeAdmin(req);
    if (auth.ok === false) return sendBffError(res, auth.code, auth.message);

    const request = adminCommerceRenewalExceptionsRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce renewal exceptions request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const snapshot = await renewalExceptionPort.collectEvidence(now(), { windowDays: request.data.windowDays });
      const result = buildAdminCommerceRenewalExceptionsResponse(snapshot, request.data);
      const response = adminCommerceRenewalExceptionsResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce renewal exceptions returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce renewal exceptions read failed");
    }
  };
}
