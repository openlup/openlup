import type { IdentityJwtLibraryLoader } from "./jwtLibrary.js";
import type { ManagedIdentityClient } from "./managedClient.js";
import {
  authenticateCustomerUser,
  authenticateCustomerUserWith,
} from "./customerAuthorization.js";
import {
  readBearerToken,
} from "./adminAuthorization.js";
import { createPostgresCustomerMePort } from "./postgresCustomerMe.js";
import type { PgGatewayClient } from "../data/index.js";
import { createSupabaseCustomerMePort as createManagedCustomerMePort } from "./managedCustomerMe.js";
import { createCustomerIdentityVerifier } from "./customerIdentityVerifier.js";
import type { CustomerMeDeps } from "./customerMeHandler.js";
import type { CustomerMePort } from "./customerPorts.js";
import { resolveBundleId } from "../kernel/index.js";

type Env = Record<string, string | undefined>;
type CustomerRequest = Parameters<typeof readBearerToken>[0];
type ManagedReadEnv = { url: string; anonKey: string };
type CreateCustomerClient = (env: ManagedReadEnv, token: string | null) => unknown;
type ActorGateway = {
  asActor<T>(
    claims: { role: "authenticated"; sub: string },
    work: (gateway: unknown) => Promise<T>,
  ): Promise<T>;
};

export type CustomerIdentityBindingOptions = {
  authenticateManaged?: typeof authenticateCustomerUser;
  createManagedClient?: CreateCustomerClient;
  createManagedPort?: typeof createManagedCustomerMePort;
  readManagedEnv?: () => ManagedReadEnv | null;
  readToken?: typeof readBearerToken;
  createPostgresGateway?: (env: Env) => ActorGateway;
  createPostgresPort?: typeof createPostgresCustomerMePort;
  createVerifier?: (config: Parameters<typeof createCustomerIdentityVerifier>[0]) => ReturnType<typeof createCustomerIdentityVerifier>;
  resolveBundle?: typeof resolveBundleId;
};

/**
 * Select the customer identity/read composition for one request. The direct
 * path constructs its profile port only inside one actor-scoped transaction;
 * it never uses a generic service lane or caller-provided token role.
 */
export function createCustomerIdentityBindingFactory(defaults: {
  loadJwt: IdentityJwtLibraryLoader;
  createManagedClient: CreateCustomerClient;
  readManagedEnv: (env: Env) => ManagedReadEnv | null;
  bindRequestActorDataPort: (token: string, env: Env) => ActorGateway | null;
}) {
return function createCustomerIdentityBinding(
  req: CustomerRequest,
  env: Env,
  options: CustomerIdentityBindingOptions = {},
): Omit<CustomerMeDeps, "responseSchema"> | null {
  const accessToken = (options.readToken ?? readBearerToken)(req);
  const bundleId = (options.resolveBundle ?? resolveBundleId)(env);

  if (bundleId !== "node-postgres") {
    const readEnv = options.readManagedEnv ?? (() => defaults.readManagedEnv(env));
    const managedEnv = readEnv();
    if (!managedEnv) return null;
    const client = (options.createManagedClient ?? defaults.createManagedClient)(
      managedEnv,
      accessToken,
    );
    return {
      authenticateUser: () =>
        (options.authenticateManaged ?? authenticateCustomerUser)(
          client,
          accessToken,
        ),
      mePort: (options.createManagedPort ?? createManagedCustomerMePort)(
        client,
      ),
    };
  }

  const gateway = (options.createPostgresGateway ?? createActorGateway)(env);
  const createPort = options.createPostgresPort ?? createPostgresCustomerMePort;
  const createVerifier =
    options.createVerifier ?? ((config) => createCustomerIdentityVerifier(config, defaults.loadJwt));
  const verifierConfig = {
    audience: env.CUSTOMER_IDENTITY_AUDIENCE ?? "",
    issuer: env.CUSTOMER_IDENTITY_ISSUER ?? "",
    jwks: env.CUSTOMER_IDENTITY_JWKS ?? "",
  };
  let verifiedPrincipalId: string | null = null;
  const mePort: CustomerMePort = {
    getCustomerMe: (principalId) => {
      if (principalId !== verifiedPrincipalId) {
        return Promise.reject(new Error("customer_principal_mismatch"));
      }
      return gateway.asActor(
        { role: "authenticated", sub: verifiedPrincipalId },
        (actorGateway) =>
          createPort(actorGateway as PgGatewayClient).getCustomerMe(
            principalId,
          ),
      );
    },
  };

  return {
    async authenticateUser() {
      const authentication = await authenticateCustomerUserWith(
        createVerifier(verifierConfig),
        accessToken,
      );
      if (authentication.ok) verifiedPrincipalId = authentication.userId;
      return authentication;
    },
    mePort,
  };
}

function createActorGateway(env: Env): ActorGateway {
  const gateway = defaults.bindRequestActorDataPort("", env);
  if (!gateway)
    throw new Error("customer identity data gateway is unavailable");
  return gateway as ActorGateway;
}

}
