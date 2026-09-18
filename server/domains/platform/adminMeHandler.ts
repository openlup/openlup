import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminPlatformMeRequestSchema,
  adminPlatformMeResponseSchema,
} from "../../../src/domains/platform/contracts.js";
import type { AdminPlatformPort } from "../../../src/domains/platform/ports.js";
import type { PlatformUserAuthenticationResult } from "./adminAuth.js";

export interface AdminPlatformMeDeps {
  platformPort: AdminPlatformPort;
  authenticateUser: (req: VercelRequest) => Promise<PlatformUserAuthenticationResult>;
}

export function createAdminPlatformMeHandler({
  platformPort,
  authenticateUser,
}: AdminPlatformMeDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    let authentication: PlatformUserAuthenticationResult;
    try {
      authentication = await authenticateUser(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Platform user authentication failed");
      return;
    }

    if (authentication.ok === false) {
      sendBffError(res, authentication.code, authentication.message);
      return;
    }

    const request = adminPlatformMeRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid platform me request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await platformPort.getAdminMe(authentication.userId);
      const response = adminPlatformMeResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Platform me returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Platform me read failed");
    }
  };
}
