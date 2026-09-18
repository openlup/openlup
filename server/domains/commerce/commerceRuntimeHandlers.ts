import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  applyHiddenCheckoutPaymentResultRequestSchema,
  applyHiddenCheckoutPaymentResultResponseSchema,
  startHiddenCheckoutRuntimeRequestSchema,
  startHiddenCheckoutRuntimeResponseSchema,
} from "../../../src/domains/commerce/runtimeContracts.js";
import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
  type CommerceCheckoutRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";

type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string };

interface CommerceRuntimeHandlerDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  runtimePort: CommerceCheckoutRuntimePort;
  mutationsEnabled: () => boolean;
}

export function createStartHiddenCheckoutRuntimeHandler({
  authorizeAdmin,
  runtimePort,
  mutationsEnabled,
}: CommerceRuntimeHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;
    if (!mutationsEnabled()) return sendBffError(res, "FORBIDDEN", "Commerce runtime mutations are not enabled");

    const request = startHiddenCheckoutRuntimeRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid hidden checkout runtime request", {
        details: request.error.flatten(),
      });
      return;
    }
    if (request.data.mode === "subscription_cycle" && !request.data.petId) {
      sendBffError(res, "BAD_REQUEST", "Invalid hidden checkout runtime request");
      return;
    }

    try {
      const result = await runtimePort.startRuntime(request.data);
      const response = startHiddenCheckoutRuntimeResponseSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Hidden checkout runtime response invalid");
      sendBffSuccess(res, response.data);
    } catch (error) {
      sendRuntimeError(res, error, "Hidden checkout runtime start failed");
    }
  };
}

export function createApplyHiddenCheckoutPaymentResultHandler({
  authorizeAdmin,
  runtimePort,
  mutationsEnabled,
}: CommerceRuntimeHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;
    if (!mutationsEnabled()) return sendBffError(res, "FORBIDDEN", "Commerce runtime mutations are not enabled");

    const request = applyHiddenCheckoutPaymentResultRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid hidden checkout payment result request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await runtimePort.applyPaymentResult(request.data);
      const response = applyHiddenCheckoutPaymentResultResponseSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Hidden checkout payment result response invalid");
      sendBffSuccess(res, response.data);
    } catch (error) {
      sendRuntimeError(res, error, "Hidden checkout payment result failed");
    }
  };
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>,
): Promise<boolean> {
  try {
    const auth = await authorizeAdmin(req);
    if (auth.ok === false) {
      sendBffError(res, auth.code, auth.message);
      return false;
    }
    return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }
}

function sendRuntimeError(res: VercelResponse, error: unknown, fallbackMessage: string): void {
  if (error instanceof CommerceRuntimeConflictError) {
    sendBffError(res, "CONFLICT", error.message, { details: error.details });
    return;
  }
  if (error instanceof CommerceRuntimePersistenceError) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", fallbackMessage, { details: error.details });
    return;
  }
  sendBffError(res, "UPSTREAM_UNAVAILABLE", fallbackMessage);
}
