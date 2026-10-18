import type { EmailTrustPolicy } from "./emailTrustPolicy.js";
import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { AccountLinkStore, IdentityVerifierPort } from "./ports.js";
import { reconcileAccountForPrincipal, type ReconcileAccountErrorCode } from "./reconcileAccountForPrincipal.js";
import { readBearerToken } from "./adminAuthorization.js";

export function createReconcileAccountHandler(options: IdentityResponseOptions & {
  verifier: IdentityVerifierPort;
  store: AccountLinkStore;
  emailTrustPolicy: EmailTrustPolicy;
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
      const result = await reconcileAccountForPrincipal(options.store, principal, options.emailTrustPolicy);
      if (!result.ok) {
        const code = result.code === "NO_VERIFIED_EMAIL" ? "BAD_REQUEST"
          : result.code === "EMAIL_TRUST_SETTINGS_UNAVAILABLE" ? "UPSTREAM_UNAVAILABLE"
          : result.code === "RESERVED_PRINCIPAL_REFUSED" || result.code === "EMAIL_TRUST_ENVELOPE_REFUSED" ? "FORBIDDEN" : "CONFLICT";
        sendBffError(res, code,
          options.message?.(result.code) ?? result.code, { details: { code: result.code } });
        return;
      }
      sendBffSuccess(res, { accountId: result.accountId, created: result.created, linked: result.linked });
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Account reconciliation failed");
    }
  };
}
