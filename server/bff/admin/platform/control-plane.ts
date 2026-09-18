import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import { readBearerToken } from "../../../_lib/admin-domain/auth.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { resolvePlatformControlPlaneBinding } from "../../../runtime/platform/controlPlaneBinding.js";
import {
  platformControlPlaneMutationResponseSchema,
  platformControlPlaneMutationSchema,
  platformControlPlaneReadResponseSchema,
} from "../../../../src/domains/platform/contracts.js";
import {
  PlatformControlPlaneConflictError,
  type PlatformControlPlanePort,
} from "../../../../src/domains/platform/ports.js";

export function createPlatformControlPlaneHandler(deps: {
  port: PlatformControlPlanePort;
  authorizeAdmin: () => Promise<boolean>;
}) {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (!(await deps.authorizeAdmin())) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }
    try {
      if (req.method === "GET") {
        const parsed = platformControlPlaneReadResponseSchema.safeParse(
          await deps.port.readControlPlane({}),
        );
        if (!parsed.success) return invalidResponse(res);
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
        if (!response.success) return invalidResponse(res);
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

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = process.env;
  const accessToken = readBearerToken(req);
  const auth = resolveAdminAuthBinding(env);
  if (!auth.binding) return unavailable(res);
  try {
    await auth.binding.run(accessToken, async (port) => {
      const authorization = await port.authorize(accessToken, { allowedRoles: ["admin"] });
      if (authorization.ok === false) {
        sendBffError(res, authorization.code, authorization.message);
        return;
      }
      const resolved = resolvePlatformControlPlaneBinding(env, { operatorId: authorization.principalId });
      if (!resolved.binding) return unavailable(res);
      await resolved.binding.run((controlPlane) => createPlatformControlPlaneHandler({
        port: controlPlane,
        authorizeAdmin: async () => true,
      })(req, res));
    });
  } catch {
    unavailable(res);
  }
}

function body(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}
function invalidResponse(res: VercelResponse): void {
  sendBffError(res, "INVALID_RESPONSE", "Platform control plane returned invalid response");
}
function unavailable(res: VercelResponse): void {
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Platform control plane unavailable");
}

export default withObservedRoute({
  route: "/api/bff/admin/platform/control-plane",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);
