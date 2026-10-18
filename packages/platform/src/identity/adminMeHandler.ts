import type { OperatorInvitationStore } from "./operatorInvitationPorts.js";
import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import { adminPlatformMeRequestSchema, adminPlatformMeResponseSchema } from "./adminContracts.js";
import type { PlatformUserAuthenticationResult } from "./platformAdminAuth.js";
export interface AdminPlatformMeDeps extends IdentityResponseOptions {
  invitationStore?: Pick<OperatorInvitationStore, "acceptOperatorInvitation">;
  platformPort: { getAdminMe(userId: string): Promise<{ isAdmin: boolean; role: "admin" | "distributor" | null }> };
  authenticateUser: (req: HttpRequest) => Promise<PlatformUserAuthenticationResult>;
}

export function createAdminPlatformMeHandler({
  platformPort, invitationStore,
  authenticateUser, responseRequestId,
}: AdminPlatformMeDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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
      if (invitationStore) {
        const outcome = await invitationStore.acceptOperatorInvitation(authentication.userId);
        if (outcome.code === "INVITATION_EXPIRED" || outcome.code === "INVITATION_REVOKED") {
          sendBffError(res, "FORBIDDEN", outcome.code, { details: { identityCode: outcome.code } });
          return;
        }
      }
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
