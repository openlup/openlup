import type { HttpHandler } from "../http/index.js";
import type { AdminAuthorizationResult } from "./ports.js";
import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import { privacyExportRequestSchema, privacyEraseRequestSchema, privacyExportResponseSchema, privacyEraseResponseSchema } from "./contracts/privacy.js";
import { PrivacyRefusal, type PrivacyOperations } from "./privacyPorts.js";
export interface PrivacyHandlerDependencies extends IdentityResponseOptions { authorizeAdmin: () => Promise<AdminAuthorizationResult>; operations: PrivacyOperations }
function handler(deps: PrivacyHandlerDependencies, erase: boolean): HttpHandler {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder(deps);
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    try {
      const auth = await deps.authorizeAdmin();
      if (!auth.ok) return sendBffError(res, auth.code, auth.message);
      if (auth.role !== "admin" || auth.isMachineActor !== false) return sendBffError(res, "FORBIDDEN", "Human administrator required");
      const parsed = (erase ? privacyEraseRequestSchema : privacyExportRequestSchema).safeParse(req.body);
      if (!parsed.success) return sendBffError(res, "BAD_REQUEST", "Invalid privacy request");
      const actor = { principalId: auth.principalId };
      const result = erase ? privacyEraseResponseSchema.parse(await deps.operations.erase(actor, privacyEraseRequestSchema.parse(parsed.data)))
        : privacyExportResponseSchema.parse(await deps.operations.export(actor, parsed.data.subject));
      return sendBffSuccess(res, result);
    } catch (error) {
      if (error instanceof PrivacyRefusal) {
        const code = error.code === "PRIVACY_SUBJECT_NOT_FOUND" ? "NOT_FOUND"
          : ["PRIVACY_ACTIVE_SUBSCRIPTION", "PRIVACY_RESUMABLE_SUBSCRIPTION", "PRIVACY_PROTECTED_OPERATOR", "PRIVACY_IDEMPOTENCY_CONFLICT", "PRIVACY_SUBJECT_ERASED"].includes(error.code) ? "CONFLICT" : "UPSTREAM_UNAVAILABLE";
        return sendBffError(res, code, "Privacy operation refused", { details: { privacyCode: error.code } });
      }
      return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Privacy operation unavailable", { details: { privacyCode: "PRIVACY_ASSESSMENT_UNAVAILABLE" } });
    }
  };
}
export const createPrivacyExportHandler = (deps: PrivacyHandlerDependencies): HttpHandler => handler(deps, false);
export const createPrivacyEraseHandler = (deps: PrivacyHandlerDependencies): HttpHandler => handler(deps, true);
