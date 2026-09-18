import { customerAuthUiEnabled, customerSelfServiceFlagEnabled } from "../../_lib/config/featureFlags.js";
import type { HttpRequest } from "../../_lib/types/http.js";
import {
  authenticateCustomerUser,
  createCustomerClient,
} from "../../_lib/customer-domain/auth.js";
import type {
  CustomerSelfServiceEnv,
  CustomerSupabaseReadEnv,
} from "../../_lib/customer-domain/auth.js";
import { readBearerToken } from "../../_lib/admin-domain/auth.js";
import { bindRequestActorDataPort } from "../../runtime/dataBinding.js";
export {
  authenticateCustomerUser,
  authenticateCustomerUserWith,
  createCustomerClient,
  createCustomerClients,
  createCustomerServiceClient,
} from "../../_lib/customer-domain/auth.js";
export type {
  CustomerSelfServiceEnv,
  CustomerSupabaseClient,
  CustomerSupabaseReadEnv,
} from "../../_lib/customer-domain/auth.js";

type CustomerAuthorization =
  | { ok: true; userId: string; accessToken: string }
  | { ok: false; code: "UNAUTHORIZED"; message: string };
type CustomerReadEnvironment = { url: string; anonKey: string };
type CustomerAuthenticationClient =
  Parameters<typeof authenticateCustomerUser>[0];

interface CustomerReferenceReadCompositionDependencies {
  readEnvironment: () => CustomerReadEnvironment | null;
  readToken: (req: HttpRequest) => string | null;
  createAuthenticationClient: (
    env: CustomerReadEnvironment,
    accessToken: string | null,
  ) => CustomerAuthenticationClient;
  authenticate: typeof authenticateCustomerUser;
  bindActor: typeof bindRequestActorDataPort;
}

const customerReferenceReadDependencies: CustomerReferenceReadCompositionDependencies = {
  readEnvironment: readCustomerReadEnvironment,
  readToken: readBearerToken,
  createAuthenticationClient: createCustomerClient,
  authenticate: authenticateCustomerUser,
  bindActor: bindRequestActorDataPort,
};

export function createCustomerReferenceReadComposition(
  req: HttpRequest,
  dependencies: CustomerReferenceReadCompositionDependencies =
    customerReferenceReadDependencies,
) {
  const env = dependencies.readEnvironment();
  if (!env) return null;

  return {
    authorize: async (): Promise<CustomerAuthorization> => {
      const accessToken = dependencies.readToken(req);
      const authorization = await dependencies.authenticate(
        dependencies.createAuthenticationClient(env, accessToken),
        accessToken,
      );
      if (authorization.ok === false) return authorization;
      if (!accessToken) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Customer session required",
        };
      }
      return { ...authorization, accessToken };
    },
    actorPort: (accessToken: string) =>
      dependencies.bindActor(accessToken, process.env),
  };
}

export function customerSelfServiceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return customerAuthUiEnabled(env) && customerSelfServiceFlagEnabled(env);
}

export function readCustomerSelfServiceEnv(
  env: Record<string, string | undefined> = process.env,
): CustomerSelfServiceEnv | null {
  const readEnv = readCustomerSupabaseReadEnv(env);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return readEnv && serviceRoleKey ? { ...readEnv, serviceRoleKey } : null;
}

export function readCustomerSupabaseReadEnv(
  env: Record<string, string | undefined> = process.env,
): CustomerSupabaseReadEnv | null {
  return readCustomerReadEnvironment(env);
}

function readCustomerReadEnvironment(
  env: Record<string, string | undefined> = process.env,
): CustomerReadEnvironment | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    env.VITE_SUPABASE_ANON_KEY ??
    env.SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export { readBearerToken } from "../../_lib/admin-domain/auth.js";
