import type { z } from "zod";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import { REFERENCE_CHECKOUT_V1 } from "../checkoutCommandSchemas.js";
import { CommerceRuntimeConflictError, CommerceRuntimePersistenceError } from "../runtimeErrors.js";
interface ReferenceRuntime { runtime: { orderId: string; clientId: string; finalizedReplayed: boolean; total: { amountMinor: number; currency: string }; payment: { paymentIntentId: string; paymentAttemptId: string | null; status: string; attemptStatus: string | null } } }
interface ReferenceSettlement { paymentResult: { status: string; replayed: boolean } }

export function createReferenceCheckoutHandler<Command, Runtime extends ReferenceRuntime, Settlement extends ReferenceSettlement, Response>({
  startCheckout,
  checkRateLimit,
  checkRiskBlocklist,
  admitProfile, responder, requestSchema, responseSchema,
}: {
  startCheckout(command: Command): Promise<{ runtime: Runtime; settlement: Settlement | null; persistence: { replayed: boolean } }>;
  checkRateLimit(req: HttpRequest, command: Command): Promise<{ allowed: boolean }>;
  checkRiskBlocklist?(req: HttpRequest, command: Command): Promise<{ blocked: boolean }>;
  admitProfile(command: Command): boolean; responder: BffResponder;
  requestSchema: z.ZodType<{ command: Command }>; responseSchema: z.ZodType<Response>;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = requestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid reference checkout request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      if (!admitProfile(request.data.command)) {
        sendBffError(res, "BAD_REQUEST", "Checkout command does not match the active reference profile");
        return;
      }
      if (!(await checkRateLimit(req, request.data.command)).allowed) {
        sendBffError(res, "RATE_LIMITED", "Reference checkout rate limit exceeded");
        return;
      }
      if (checkRiskBlocklist && (await checkRiskBlocklist(req, request.data.command)).blocked) {
        sendBffError(res, "FORBIDDEN", "Reference checkout cannot be completed");
        return;
      }

      // Settlement is owned by the shared paid-order service, not by this
      // handler: it is present exactly when that service settled the attempt,
      // and absent when the runtime is still awaiting or already refused it.
      const result = await startCheckout(request.data.command);
      const settled = result.settlement;
      const response = responseSchema.safeParse({
        version: REFERENCE_CHECKOUT_V1,
        orderId: result.runtime.runtime.orderId,
        clientId: result.runtime.runtime.clientId,
        paymentIntentId: result.runtime.runtime.payment.paymentIntentId,
        paymentAttemptId: result.runtime.runtime.payment.paymentAttemptId,
        paymentStatus: settled?.paymentResult.status ?? result.runtime.runtime.payment.status,
        paymentAttemptStatus: settled
          ? "succeeded"
          : result.runtime.runtime.payment.attemptStatus,
        replayed: result.persistence.replayed ||
          result.runtime.runtime.finalizedReplayed ||
          (settled?.paymentResult.replayed ?? false),
        total: result.runtime.runtime.total,
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Reference checkout returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data, { contractVersion: REFERENCE_CHECKOUT_V1 });
    } catch (error) {
      if (error instanceof CommerceRuntimeConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      if (error instanceof CommerceRuntimePersistenceError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference checkout persistence failed");
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference checkout failed");
    }
  };
}
