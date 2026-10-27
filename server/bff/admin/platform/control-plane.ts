import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { readBearerToken } from "../../../_lib/admin-domain/auth.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { resolvePlatformControlPlaneBinding } from "../../../runtime/platform/controlPlaneBinding.js";
import { createPlatformControlPlaneHandler as createOperationsHandler } from "@openlup/platform/operations/server";
import { readObservedResponseContext } from "../../../_lib/observability/requestContext.js";

export function createPlatformControlPlaneHandler(deps: Parameters<typeof createOperationsHandler>[0]) {
  return createOperationsHandler({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
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

function unavailable(res: VercelResponse): void {
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Platform control plane unavailable");
}

export default withObservedRoute({
  route: "/api/bff/admin/platform/control-plane",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);
