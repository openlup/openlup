import { createAdminAuthBindingResolver, createAdminBffPreflight, type AdminAuthBindingOptions, type PlatformOperatorChecker } from "@openlup/platform/identity";
export type { AdminAuthBinding, AdminAuthBindingOptions, AdminAuthBindingResolution, PlatformOperatorChecker, PlatformOperatorCheckerFactory } from "@openlup/platform/identity";
import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
import { MACHINE_ACTOR_WRITE_ROUTES, allowedAdminRolesForBffRoute } from "../../_lib/admin-domain/auth.js";
import { createSupabaseAdminAuthFromEnv } from "../../adapters/supabase/adminAuthVerifier.js";
import { createPostgresCommunicationsControlPlanePort } from "../../adapters/postgres/communicationsControlPlane.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
type Env = Record<string, string | undefined>;
function createPlatformOperatorChecker(env: Env): PlatformOperatorChecker {
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) throw new Error("database_url_required");
  const operatorId = env.PLATFORM_OPERATOR_ID?.trim() ?? "";
  const port = createPostgresCommunicationsControlPlanePort({ connectionString }, { operatorId });
  return {
    isOperatorAllowed: (principalId) => port.isOperatorActive(principalId),
    close: () => port.close(),
  };
}

export const resolveAdminAuthBinding = createAdminAuthBindingResolver({
  checkerFactory: createPlatformOperatorChecker,
  managedAuthFactory: createSupabaseAdminAuthFromEnv,
});
export async function preflightAdminBffRoute(
  req: VercelRequest,
  res: VercelResponse,
  route: string,
  env: Env = process.env,
  options: AdminAuthBindingOptions = {},
): Promise<boolean> {
  return createAdminBffPreflight({
    responseRequestId: (res) => readObservedResponseContext(res)?.requestId,
    allowedRoles: allowedAdminRolesForBffRoute,
    resolveBinding: () => resolveAdminAuthBinding(env, options),
    machineWriteRoutes: MACHINE_ACTOR_WRITE_ROUTES,
    managedEnvironmentMessage: "Supabase environment is not configured",
  })(req, res, route);
}
