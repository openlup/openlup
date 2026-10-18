import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import { z } from "zod";
z.config({ jitless: true });
import type { HttpRequest, HttpResponse } from "../http/index.js";
import { resolveCustomerSessionBinding } from "./customerSessionBinding.js";
const customerOtpVerifyRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  token: z.string().trim().min(16).max(256),
}).strict();

const customerOtpVerifyResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  user: z.object({ id: z.guid(), email: z.string().email() }).strict(),
}).strict();

export function createCustomerVerifyOtpHandler(options: IdentityResponseOptions & { enabled: () => boolean; env: Record<string, string | undefined>; resolveSession: typeof resolveCustomerSessionBinding }) {
const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder(options);
return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
  if (!options.enabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer accounts are disabled");
    return;
  }
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  const request = customerOtpVerifyRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid one-time code request", { details: request.error.flatten() });
    return;
  }
  const resolved = options.resolveSession(options.env);
  if (!resolved.binding) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer auth is not configured", {
      details: { feature: "customer_auth", reason: resolved.error },
    });
    return;
  }
  const session = await resolved.binding.verifyChallenge(request.data.token);
  if (!session) {
    sendBffError(res, "UNAUTHORIZED", "One-time code is invalid or expired");
    return;
  }
  sendBffSuccess(res, customerOtpVerifyResponseSchema.parse(session));
};
}
