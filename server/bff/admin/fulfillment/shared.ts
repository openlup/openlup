import { sendBffError, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
  type AdminRole,
  type SupabaseAuthClient,
} from "../../../_lib/admin-domain/auth.js";

export interface FulfillmentAdminAuthContext {
  client: SupabaseAuthClient;
  accessToken: string | null;
}

export function createFulfillmentAdminAuthContext(req: VercelRequest): FulfillmentAdminAuthContext | null {
  const env = readSupabaseAdminAuthEnv();
  if (!env) return null;

  const accessToken = readBearerToken(req);
  return {
    client: createAdminAuthClient(env, accessToken),
    accessToken,
  };
}

export function authorizeFulfillmentAdmin(
  client: SupabaseAuthClient,
  accessToken: string | null,
  allowedRoles: readonly AdminRole[],
): Promise<boolean> {
  return authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles });
}

export async function refuseRetiredDirectDhlAction(
  req: VercelRequest,
  res: VercelResponse,
  options: {
    allowedRoles: readonly AdminRole[];
    reason: string;
    message: string;
  },
): Promise<void> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }
  const auth = createFulfillmentAdminAuthContext(req);
  if (!auth) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }
  try {
    const authorized = await authorizeFulfillmentAdmin(auth.client, auth.accessToken, options.allowedRoles);
    if (!authorized) {
      sendBffError(res, "UNAUTHORIZED", "Unauthorized");
      return;
    }
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization unavailable");
    return;
  }
  sendBffError(res, "NOT_FOUND", options.message, {
    details: { reason: options.reason },
  });
}
