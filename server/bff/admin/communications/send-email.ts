import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import {
  createCommunicationsSendEmailHandler,
} from "../../../domains/communications/sendEmailHandler.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
} from "../../../_lib/admin-domain/auth.js";
import { resolveBundleId } from "../../../domains/platform-runtime/platformKernel.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { resolveCommunicationsControlPlaneBinding } from "../../../runtime/communications/controlPlaneBinding.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }
  if (resolveBundleId(process.env) === "node-postgres") {
    await handleDirect(req, res);
    return;
  }
  const env = readSupabaseAdminAuthEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);

  if (!(await authorizeAdmin(client, accessToken))) {
    sendBffError(res, "UNAUTHORIZED", "Admin session required");
    return;
  }

  // The managed route was exclusively composed with the tester-template
  // binding. Reject after authorization and before that binding or any send
  // port can be constructed. The node-postgres communications route above is
  // intentionally untouched because it can serve neutral use cases.
  sendBffError(res, "NOT_FOUND", "Tester programme email is no longer available");
}

async function handleDirect(req: VercelRequest, res: VercelResponse): Promise<void> {
  const accessToken = readBearerToken(req);
  const auth = resolveAdminAuthBinding(process.env);
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
      const resolved = resolveCommunicationsControlPlaneBinding(process.env, {
        operatorId: authorization.principalId,
      });
      if (!resolved.binding) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communications control plane unavailable");
        return;
      }
      await resolved.binding.run((sendPort) => createCommunicationsSendEmailHandler({
        sendPort,
        authorizeAdmin: async () => true,
      })(req, res));
    });
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communications send-email request failed");
  }
}

async function authorizeAdmin(
  client: Parameters<typeof authorizeAdminBooleanWithUser>[0],
  accessToken: string | null,
): Promise<boolean> {
  return authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export default withObservedRoute({
  route: "/api/bff/admin/communications/send-email",
  domain: "communications",
  surface: "admin",
  risk: "provider",
}, handler);
