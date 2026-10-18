import { createOperatorTokenAdminAuth, resolvePlatformOperatorAuthConfig } from "./operatorTokenAdminAuth.js";
import { resolveBundleId } from "../kernel/index.js";
import type { AdminAuthPort } from "./ports.js";
import type { AdminAuthBinding } from "./adminPreflight.js";
type Env = Record<string, string | undefined>;
export interface PlatformOperatorChecker { isOperatorAllowed(principalId: string): Promise<boolean>; close(): Promise<void> }
export type PlatformOperatorCheckerFactory = (env: Env) => PlatformOperatorChecker | Promise<PlatformOperatorChecker>;
export type AdminAuthBindingResolution =
  | { readonly binding: AdminAuthBinding; readonly error?: undefined }
  | { readonly binding?: undefined; readonly error: "managed_admin_auth_env_required" | "direct_admin_auth_config_invalid" };
export interface AdminAuthBindingOptions {
  humanAuthFactory?: (env: Env) => AdminAuthPort & { close(): Promise<void> };
  checkerFactory?: PlatformOperatorCheckerFactory;
  managedAuthFactory?: (env: { url: string; anonKey: string }, accessToken: string | null) => AdminAuthPort;
}
function managedAuthEnv(env: Env): { url: string; anonKey: string } | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/** Bind the admin authorizer selected by PLATFORM_BUNDLE. */
export function createAdminAuthBindingResolver(defaults: Required<Pick<AdminAuthBindingOptions, "checkerFactory" | "managedAuthFactory">> & Pick<AdminAuthBindingOptions, "humanAuthFactory">) {
return function resolveAdminAuthBinding(
  env: Env,
  options: AdminAuthBindingOptions = {},
): AdminAuthBindingResolution {
  const bundleId = resolveBundleId(env);
  if (bundleId === "node-postgres") {
    const config = resolvePlatformOperatorAuthConfig(env);
    const humanFactory = options.humanAuthFactory ?? defaults.humanAuthFactory;
    const humanEnabled = !!env.OPERATOR_IDENTITY_AUDIENCE && !!humanFactory;
    if (!config.config && !humanEnabled) return { error: "direct_admin_auth_config_invalid" };
    const checkerFactory = options.checkerFactory ?? defaults.checkerFactory;
    return {
      binding: {
        identity: bundleId,
        async run(accessToken, work) {
          const scope: { checker?: PlatformOperatorChecker } = {};
          const machine = config.config ? createOperatorTokenAdminAuth(config.config, async (principalId) => {
            scope.checker ??= await checkerFactory(env);
            return scope.checker.isOperatorAllowed(principalId);
          }) : null;
          let human: (AdminAuthPort & { close(): Promise<void> }) | undefined;
          const auth: AdminAuthPort = { async authorize(token, restrictions) {
            // Only a credential mismatch may select human verification; machine
            // revocation and database errors retain their existing result.
            const result = machine ? await machine.authorize(token, restrictions) : null;
            if (result && (result.ok || result.code !== "UNAUTHORIZED")) return result;
            if (!humanEnabled || !token) return result ?? { ok: false, code: "UNAUTHORIZED", message: "Operator authentication required" };
            human ??= humanFactory!(env);
            return human.authorize(token, restrictions);
          } };
          try {
            return await work(auth);
          } finally {
            try { await scope.checker?.close(); } finally { await human?.close(); }
          }
        },
      },
    };
  }

  const authEnv = managedAuthEnv(env);
  if (!authEnv) return { error: "managed_admin_auth_env_required" };
  const managedAuthFactory = options.managedAuthFactory ?? defaults.managedAuthFactory;
  return {
    binding: {
      identity: bundleId,
      run: (accessToken, work) => work(managedAuthFactory(authEnv, accessToken)),
    },
  };
}


}
