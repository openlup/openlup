import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { AccountLinkStore, IdentityVerifierPort } from "./ports.js";
import { reconcileAccountForPrincipal, type ReconcileAccountErrorCode } from "./reconcileAccountForPrincipal.js";
import { readBearerToken } from "./adminAuthorization.js";

export function createReconcileAccountHandler(options: IdentityResponseOptions & {
  verifier: IdentityVerifierPort;
  store: AccountLinkStore;
  message?: (code: ReconcileAccountErrorCode) => string;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder(options);
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const token = readBearerToken(req);
    if (!token) return sendBffError(res, "UNAUTHORIZED", "Customer session required");
    try {
      const principal = await options.verifier.verifyAccessToken(token);
      if (!principal) return sendBffError(res, "UNAUTHORIZED", "Customer session required");
      const result = await reconcileAccountForPrincipal(options.store, principal);
      if (!result.ok) {
        const status = result.code === "NO_VERIFIED_EMAIL" ? 400 : result.code === "RESERVED_PRINCIPAL_REFUSED" ? 403 : 409;
        sendBffError(res, status === 400 ? "BAD_REQUEST" : status === 403 ? "FORBIDDEN" : "CONFLICT",
          options.message?.(result.code) ?? result.code, { details: { code: result.code } });
        return;
      }
      sendBffSuccess(res, { accountId: result.accountId, created: result.created, linked: result.linked });
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Account reconciliation failed");
    }
  };
}
