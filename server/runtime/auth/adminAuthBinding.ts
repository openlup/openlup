import { createOperatorTokenAdminAuth, resolvePlatformOperatorAuthConfig } from "../../adapters/platform/operatorTokenAdminAuth.js";
import { createSupabaseAdminAuthFromEnv } from "../../adapters/supabase/adminAuthVerifier.js";
import {
  allowedAdminRolesForBffRoute,
  readBearerToken,
} from "../../_lib/admin-domain/auth.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminAuthPort } from "../../domains/auth/ports.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { createPostgresCommunicationsControlPlanePort } from "../../adapters/postgres/communicationsControlPlane.js";

type Env = Record<string, string | undefined>;
export interface PlatformOperatorChecker {
  isOperatorAllowed(principalId: string): Promise<boolean>;
  close(): Promise<void>;
}
export type PlatformOperatorCheckerFactory = (env: Env) => PlatformOperatorChecker | Promise<PlatformOperatorChecker>;

export interface AdminAuthBinding {
  readonly identity: string;
  run<T>(accessToken: string | null, work: (auth: AdminAuthPort) => Promise<T>): Promise<T>;
}

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

export type AdminAuthBindingResolution =
  | { readonly binding: AdminAuthBinding; readonly error?: undefined }
  | { readonly binding?: undefined; readonly error: "managed_admin_auth_env_required" | "direct_admin_auth_config_invalid" };

export interface AdminAuthBindingOptions {
  checkerFactory?: PlatformOperatorCheckerFactory;
  managedAuthFactory?: (
    env: { url: string; anonKey: string },
    accessToken: string | null,
  ) => AdminAuthPort;
}

function managedAuthEnv(env: Env): { url: string; anonKey: string } | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/** Bind the admin authorizer selected by PLATFORM_BUNDLE. */
export function resolveAdminAuthBinding(
  env: Env,
  options: AdminAuthBindingOptions = {},
): AdminAuthBindingResolution {
  const bundleId = resolveBundleId(env);
  if (bundleId === "node-postgres") {
    const config = resolvePlatformOperatorAuthConfig(env);
    if (!config.config) return { error: "direct_admin_auth_config_invalid" };
    const checkerFactory = options.checkerFactory ?? createPlatformOperatorChecker;
    return {
      binding: {
        identity: bundleId,
        async run(accessToken, work) {
          const scope: { checker?: PlatformOperatorChecker } = {};
          const auth = createOperatorTokenAdminAuth(config.config, async (principalId) => {
            scope.checker ??= await checkerFactory(env);
            return scope.checker.isOperatorAllowed(principalId);
          });
          try {
            return await work(auth);
          } finally {
            await scope.checker?.close();
          }
        },
      },
    };
  }

  const authEnv = managedAuthEnv(env);
  if (!authEnv) return { error: "managed_admin_auth_env_required" };
  const managedAuthFactory = options.managedAuthFactory ?? createSupabaseAdminAuthFromEnv;
  return {
    binding: {
      identity: bundleId,
      run: (accessToken, work) => work(managedAuthFactory(authEnv, accessToken)),
    },
  };
}

/** Bundle-aware global preflight for every protected admin BFF route. */
export async function preflightAdminBffRoute(
  req: VercelRequest,
  res: VercelResponse,
  route: string,
  env: Env = process.env,
  options: AdminAuthBindingOptions = {},
): Promise<boolean> {
  const allowedRoles = allowedAdminRolesForBffRoute(route);
  if (!allowedRoles) return true;

  const resolved = resolveAdminAuthBinding(env, options);
  if (!resolved.binding) {
    if (resolved.error === "managed_admin_auth_env_required") {
      sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    } else {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    }
    return false;
  }

  const accessToken = readBearerToken(req);
  try {
    const authz = await resolved.binding.run(
      accessToken,
      (auth) => auth.authorize(accessToken, { allowedRoles }),
    );
    if (authz.ok === false) {
      sendBffError(res, authz.code, authz.message);
      return false;
    }
    return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }
}
