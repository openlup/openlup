import {
  authenticateCustomerUser,
  authenticateCustomerUserWith,
  createCustomerClient,
} from "../../_lib/customer-domain/auth.js";
import {
  readBearerToken,
  readCustomerSupabaseReadEnv as readManagedEnvironment,
} from "../../bff/customers/shared.js";
import { bindRequestActorDataPort } from "../dataBinding.js";
import { createPostgresCustomerMePort } from "../../adapters/postgres/customerMe.js";
import type { PgGatewayClient } from "../../adapters/postgres/queryBuilder.js";
import { createSupabaseCustomerMePort as createManagedCustomerMePort } from "../../adapters/supabase/customerMe.js";
import { createCustomerIdentityVerifier } from "../../adapters/jwt/customerIdentityVerifier.js";
import type { CustomerMeDeps } from "../../domains/customers/customerMeHandler.js";
import type { CustomerMePort } from "../../domains/customers/ports.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;
type CustomerRequest = Parameters<typeof readBearerToken>[0];
type ManagedReadEnv = NonNullable<ReturnType<typeof readManagedEnvironment>>;
type ActorGateway = {
  asActor<T>(
    claims: { role: "authenticated"; sub: string },
    work: (gateway: unknown) => Promise<T>,
  ): Promise<T>;
};

type BindingOptions = {
  authenticateManaged?: typeof authenticateCustomerUser;
  createManagedClient?: typeof createCustomerClient;
  createManagedPort?: typeof createManagedCustomerMePort;
  readManagedEnv?: () => ManagedReadEnv | null;
  readToken?: typeof readBearerToken;
  createPostgresGateway?: (env: Env) => ActorGateway;
  createPostgresPort?: typeof createPostgresCustomerMePort;
  createVerifier?: typeof createCustomerIdentityVerifier;
  resolveBundle?: typeof resolveBundleId;
};

/**
 * Select the customer identity/read composition for one request. The direct
 * path constructs its profile port only inside one actor-scoped transaction;
 * it never uses a generic service lane or caller-provided token role.
 */
export function createCustomerIdentityBinding(
  req: CustomerRequest,
  env: Env = process.env,
  options: BindingOptions = {},
): CustomerMeDeps | null {
  const accessToken = (options.readToken ?? readBearerToken)(req);
  const bundleId = (options.resolveBundle ?? resolveBundleId)(env);

  if (bundleId !== "node-postgres") {
    const readEnv = options.readManagedEnv ?? readManagedEnvironment;
    const managedEnv = readEnv();
    if (!managedEnv) return null;
    const client = (options.createManagedClient ?? createCustomerClient)(
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
    options.createVerifier ?? createCustomerIdentityVerifier;
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
  const gateway = bindRequestActorDataPort("", env);
  if (!gateway)
    throw new Error("customer identity data gateway is unavailable");
  return gateway as ActorGateway;
}
