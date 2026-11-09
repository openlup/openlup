import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { CustomerAccountMutationPort } from "../contracts/mutations.js";
import type { CustomerAccountMutationSchemas } from "./accountMutationSchemas.js";
export interface CustomerAccountMutationHandlerDependencies {
  port: CustomerAccountMutationPort;
  authenticate(req: HttpRequest): Promise<{ ok: true; userId: string } | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }>;
  /** Application-owned messages, including validation and transport failures. */
  messages: { authentication: string; profileInvalid: string; correctionInvalid: string; unlinked: string; invoiceMissing: string; invalidResponse: string; failed: string };
}
export function createCustomerAccountMutationHandlers(deps: CustomerAccountMutationHandlerDependencies, schemas: CustomerAccountMutationSchemas, responder: BffResponder) {
  const handler = (profile: boolean) => async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    const method = profile ? "PATCH" : "POST";
    if (req.method !== method) { responder.sendMethodNotAllowed(res, [method]); return; }
    let auth: Awaited<ReturnType<typeof deps.authenticate>>;
    try { auth = await deps.authenticate(req); }
    catch { responder.sendBffError(res, "UPSTREAM_UNAVAILABLE", deps.messages.authentication); return; }
    if (!auth.ok) { responder.sendBffError(res, auth.code, auth.message); return; }
    if (profile) {
      const input = schemas.profileRequest.safeParse(req.body);
      if (!input.success) { responder.sendBffError(res, "BAD_REQUEST", deps.messages.profileInvalid, { details: input.error.flatten() }); return; }
      try {
        const result = await deps.port.updateProfile(auth.userId, input.data);
        if (!result) { responder.sendBffError(res, "FORBIDDEN", deps.messages.unlinked); return; }
        const response = schemas.profileResponse.safeParse(result);
        if (!response.success) { responder.sendBffError(res, "INVALID_RESPONSE", deps.messages.invalidResponse); return; }
        responder.sendBffSuccess(res, response.data);
      } catch { responder.sendBffError(res, "UPSTREAM_UNAVAILABLE", deps.messages.failed); }
    } else {
      const input = schemas.correctionRequest.safeParse(req.body);
      if (!input.success) { responder.sendBffError(res, "BAD_REQUEST", deps.messages.correctionInvalid, { details: input.error.flatten() }); return; }
      try {
        const result = await deps.port.requestInvoiceCorrection(auth.userId, input.data);
        if (!result) { responder.sendBffError(res, "NOT_FOUND", deps.messages.invoiceMissing); return; }
        const response = schemas.correctionResponse.safeParse(result);
        if (!response.success) { responder.sendBffError(res, "INVALID_RESPONSE", deps.messages.invalidResponse); return; }
        responder.sendBffSuccess(res, response.data);
      } catch { responder.sendBffError(res, "UPSTREAM_UNAVAILABLE", deps.messages.failed); }
    }
  };
  return { profile: handler(true), invoiceCorrection: handler(false) };
}
