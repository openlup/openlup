import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../../_lib/bff/response.js";
import { readBearerToken } from "../../../_lib/admin-domain/auth.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { resolveCommunicationsControlPlaneBinding } from "../../../runtime/communications/controlPlaneBinding.js";
import {
  communicationsDeliveryControlMutationResponseSchema,
  communicationsDeliveryControlMutationSchema,
  communicationsCapturedSendResponseSchema,
  communicationsDeliveryOperationEventsRequestSchema,
  communicationsDeliveryOperationEventsResponseSchema,
  communicationsDeliveryOperationsRequestSchema,
  communicationsDeliveryOperationsResponseSchema,
} from "../../../../src/domains/communications/contracts.js";
import {
  CommunicationConflictError,
  CommunicationUnavailableError,
  CommunicationValidationError,
  type CommunicationControlPlanePort,
} from "../../../../src/domains/communications/ports.js";

export function createCommunicationsControlPlaneHandler(deps: {
  port: CommunicationControlPlanePort;
  authorizeAdmin: () => Promise<boolean>;
}) {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (!(await deps.authorizeAdmin())) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }
    try {
      if (req.method === "GET") {
        const idempotencyKey = queryValue(req.query?.idempotencyKey);
        if (idempotencyKey) {
          const parsed = communicationsDeliveryOperationEventsRequestSchema.safeParse({ idempotencyKey });
          if (!parsed.success) return badRequest(res);
          return sendParsed(res, communicationsDeliveryOperationEventsResponseSchema,
            await deps.port.getDeliveryOperationEvents(parsed.data));
        }
        const parsed = communicationsDeliveryOperationsRequestSchema.safeParse(req.query ?? {});
        if (!parsed.success) return badRequest(res);
        return sendParsed(res, communicationsDeliveryOperationsResponseSchema,
          await deps.port.getDeliveryOperations(parsed.data));
      }
      if (req.method === "POST") {
        const parsed = communicationsDeliveryControlMutationSchema.safeParse(body(req.body));
        if (!parsed.success) return badRequest(res);
        if (parsed.data.action === "send") {
          const result = await deps.port.sendEmail({
            recipientId: parsed.data.recipientReference,
            templateSlug: parsed.data.templateReference,
            idempotencyKey: parsed.data.idempotencyKey,
          });
          return sendParsed(res, communicationsCapturedSendResponseSchema, {
            accepted: true,
            deliveryReference: result.message.id,
          });
        }
        return sendParsed(res, communicationsDeliveryControlMutationResponseSchema,
          await deps.port.mutateDeliveryControl(parsed.data));
      }
      sendMethodNotAllowed(res, ["GET", "POST"]);
    } catch (error) {
      if (error instanceof CommunicationConflictError) {
        sendBffError(res, "CONFLICT", error.message);
        return;
      }
      if (error instanceof CommunicationValidationError) {
        sendBffError(res, "BAD_REQUEST", error.message);
        return;
      }
      if (!(error instanceof CommunicationUnavailableError)) {
        // The public envelope stays sanitized for unknown adapter/DB failures.
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communications control plane unavailable");
    }
  };
}

function sendParsed(
  res: VercelResponse,
  schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } },
  value: unknown,
): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    sendBffError(res, "INVALID_RESPONSE", "Communications control plane returned invalid response");
    return;
  }
  sendBffSuccess(res, parsed.data);
}

function badRequest(res: VercelResponse): void {
  sendBffError(res, "BAD_REQUEST", "Invalid communications control-plane request");
}

function queryValue(value: unknown): string | undefined {
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
}

function body(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = process.env;
  const accessToken = readBearerToken(req);
  const auth = resolveAdminAuthBinding(env);
  if (!auth.binding) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return;
  }
  try {
    await auth.binding.run(accessToken, async (port) => {
      const authorization = await port.authorize(accessToken, { allowedRoles: ["admin"] });
      if (authorization.ok === false) {
        sendBffError(res, authorization.code, authorization.message);
        return;
      }
      const resolved = resolveCommunicationsControlPlaneBinding(env, {
        operatorId: authorization.principalId,
      });
      if (!resolved.binding) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communications control plane unavailable");
        return;
      }
      await resolved.binding.run((controlPlane) => createCommunicationsControlPlaneHandler({
        port: controlPlane,
        authorizeAdmin: async () => true,
      })(req, res));
    });
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communications control plane unavailable");
  }
}

export default withObservedRoute({
  route: "/api/bff/admin/communications/delivery-operations",
  domain: "communications",
  surface: "admin",
  risk: "mutation",
}, handler);
