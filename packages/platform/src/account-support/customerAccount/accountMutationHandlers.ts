import type { CustomerAccountMutationPort } from "../contracts/mutations.js";
import type { CustomerAccountMutationSchemas } from "./accountMutationSchemas.js";
/** Host transport shape; importing this handler does not require Node HTTP types. */
export interface CustomerAccountMutationHandlerRequest {
  method?: string;
  body?: unknown;
}
export interface CustomerAccountMutationHandlerResponder<Response> {
  sendMethodNotAllowed(res: Response, methods: readonly string[]): void;
  sendBffSuccess(res: Response, data: unknown): void;
  sendBffError(res: Response, code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "INVALID_RESPONSE" | "NOT_FOUND" | "UPSTREAM_UNAVAILABLE", message: string, options?: { details: unknown }): void;
}
export interface CustomerAccountMutationHandlerDependencies<Request extends CustomerAccountMutationHandlerRequest = CustomerAccountMutationHandlerRequest> {
  port: CustomerAccountMutationPort;
  authenticate(req: Request): Promise<{ ok: true; userId: string } | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }>;
  /** Application-owned messages, including validation and transport failures. */
  messages: { authentication: string; profileInvalid: string; correctionInvalid: string; unlinked: string; invoiceMissing: string; invalidResponse: string; failed: string };
}
export function createCustomerAccountMutationHandlers<Request extends CustomerAccountMutationHandlerRequest, Response>(
  deps: CustomerAccountMutationHandlerDependencies<Request>, schemas: CustomerAccountMutationSchemas, responder: CustomerAccountMutationHandlerResponder<Response>,
) {
  const handler = (profile: boolean) => async (req: Request, res: Response): Promise<void> => {
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
