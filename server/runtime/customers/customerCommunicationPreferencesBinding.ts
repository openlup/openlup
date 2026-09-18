import { authenticateCustomerUser, authenticateCustomerUserWith } from "../../_lib/customer-domain/auth.js";
import { createCustomerIdentityVerifier } from "../../adapters/jwt/customerIdentityVerifier.js";
import { createPostgresCustomerCommunicationPreferencesPort } from "../../adapters/postgres/customerRecovery.js";
import type { PgGatewayClient } from "../../adapters/postgres/queryBuilder.js";
import { createSupabaseCustomerCommunicationPreferencesPort } from "../../adapters/supabase/communications/customerCommunicationPreferences.js";
import { readBearerToken, readCustomerSelfServiceEnv, createCustomerClients } from "../../bff/customers/shared.js";
import type { CustomerCommunicationPreferencesDeps } from "../../domains/communications/customerCommunicationPreferencesHandler.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { bindRequestActorDataPort } from "../dataBinding.js";

type Env = Record<string, string | undefined>;
type Request = Parameters<typeof readBearerToken>[0];

export function createCustomerCommunicationPreferencesBinding(
  req: Request,
  env: Env = process.env,
): CustomerCommunicationPreferencesDeps | null {
  const accessToken = readBearerToken(req);
  if (resolveBundleId(env) !== "node-postgres") {
    const managedEnv = readCustomerSelfServiceEnv();
    if (!managedEnv) return null;
    const clients = createCustomerClients(managedEnv, accessToken);
    return {
      preferencesPort: createSupabaseCustomerCommunicationPreferencesPort(clients),
      authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
    };
  }

  const gateway = bindRequestActorDataPort("", env);
  if (!gateway) return null;
  const verifier = createCustomerIdentityVerifier({
    audience: env.CUSTOMER_IDENTITY_AUDIENCE ?? "",
    issuer: env.CUSTOMER_IDENTITY_ISSUER ?? "",
    jwks: env.CUSTOMER_IDENTITY_JWKS ?? "",
  });
  let principalId: string | null = null;
  const preferencesPort = createPostgresCustomerCommunicationPreferencesPort({
    rpc(name, args) {
      if (!principalId) return Promise.reject(new Error("customer principal unavailable"));
      return gateway.asActor(
        { role: "authenticated", sub: principalId },
        (actorGateway) => (actorGateway as PgGatewayClient).rpc(name, args),
      );
    },
  });
  return {
    async authenticateUser() {
      const auth = await authenticateCustomerUserWith(verifier, accessToken);
      if (auth.ok) principalId = auth.userId;
      return auth;
    },
    preferencesPort,
  };
}
