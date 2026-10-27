import { createBffResponder, type BffResponderOptions, type BffResponder } from "../../bff/index.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import { platformControlPlaneMutationResponseSchema, platformControlPlaneMutationSchema, platformControlPlaneReadResponseSchema } from "../index.js";
import { PlatformControlPlaneConflictError } from "../index.js";
import type { PlatformControlPlanePort } from "../contracts/index.js";

export function createPlatformControlPlaneHandler(deps: {
  port: PlatformControlPlanePort;
  authorizeAdmin: () => Promise<boolean>;
} & BffResponderOptions) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createBffResponder(deps);
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (!(await deps.authorizeAdmin())) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }
    try {
      if (req.method === "GET") {
        const parsed = platformControlPlaneReadResponseSchema.safeParse(
          await deps.port.readControlPlane({}),
        );
        if (!parsed.success) return invalidResponse(res, sendBffError);
        sendBffSuccess(res, parsed.data);
        return;
      }
      if (req.method === "POST") {
        const parsed = platformControlPlaneMutationSchema.safeParse(body(req.body));
        if (!parsed.success) {
          sendBffError(res, "BAD_REQUEST", "Invalid platform control-plane request");
          return;
        }
        const response = platformControlPlaneMutationResponseSchema.safeParse(
          await deps.port.mutateControlPlane(parsed.data),
        );
        if (!response.success) return invalidResponse(res, sendBffError);
        sendBffSuccess(res, response.data);
        return;
      }
      sendMethodNotAllowed(res, ["GET", "POST"]);
    } catch (error) {
      if (error instanceof PlatformControlPlaneConflictError) {
        sendBffError(res, "CONFLICT", error.message);
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Platform control plane unavailable");
    }
  };
}

function body(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}
function invalidResponse(res: HttpResponse, sendBffError: BffResponder["sendBffError"]): void {
  sendBffError(res, "INVALID_RESPONSE", "Platform control plane returned invalid response");
}