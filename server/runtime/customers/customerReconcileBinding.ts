import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createCustomerIdentityBinding } from "./customerIdentityBinding.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";

/** Direct redemption already linked the contact; reconciliation only reads that actor's link. */
export function createDirectCustomerReconcileHandler(
  env: Record<string, string | undefined>,
  bind = createCustomerIdentityBinding,
) {
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    try {
      const binding = bind(req, env);
      if (!binding) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer identity unavailable");
      const auth = await binding.authenticateUser(req);
      if (!auth.ok) return sendBffError(res, auth.code, auth.message);
      const contact = await binding.mePort.getCustomerMe(auth.userId);
      if (!contact) return sendBffError(res, "CONFLICT", "No customer account linked to this session", { details: { code: "ACCOUNT_LINK_CONFLICT" } });
      return sendBffSuccess(res, { accountId: contact.clientId, created: false, linked: false });
    } catch { return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer reconciliation unavailable"); }
  };
}
