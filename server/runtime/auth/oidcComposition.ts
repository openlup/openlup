import { createOidcIdentityVerifier, createPostgresAccountLinkStore, createVerifierResultOnlyEmailTrustPolicy,
  createPostgresOperatorIdentityStore, createOperatorAdminAuth, createReconcileAccountHandler,
  createCustomerMeHandler, createPostgresCustomerMePort, customerMeResponseSchema, readBearerToken,
  authenticateCustomerUserWith, identityOidcReadiness, type IdentityJwtLibraryLoader, type OidcIdentityVerifier } from "@openlup/platform/identity";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import type { RouteEntry } from "@openlup/platform/bff";
import type { DataGatewayPort } from "@openlup/core/platform-runtime";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { loadOidcJwt } from "./oidcJwtAdapter.js";

type Environment = Record<string, string | undefined>;
/** Explicit opt-in binding; retain this object for the host lifetime to preserve cache/rate limits. */
export function createOidcComposition(environment: Environment, dependencies: {
  loadJwt?: IdentityJwtLibraryLoader; fetch?: typeof globalThis.fetch; now?: () => number;
  allowLoopbackHttp?: boolean; customerGateway?: DataGatewayPort;
} = {}) {
  const env = Object.freeze({ ...environment });
  if (env.PLATFORM_BUNDLE !== "node-postgres") throw new Error("OIDC_NATIVE_SESSION_REQUIRED");
  const issuer = env.IDENTITY_OIDC_ISSUER ?? "";
  const customerAudience = env.IDENTITY_OIDC_CUSTOMER_AUDIENCE ?? "";
  const operatorAudience = env.IDENTITY_OIDC_OPERATOR_AUDIENCE ?? "";
  if (!env.DATABASE_URL?.trim() || !issuer || !customerAudience || !operatorAudience || customerAudience === operatorAudience) throw new Error("OIDC_CONFIGURATION_INVALID");
  const create = (audience: string, operator: boolean) => createOidcIdentityVerifier({ issuer, audience, algorithms: ["RS256", "ES256"],
    maxTokenLifetimeSeconds: operator ? 900 : 3600, requireSingleAudience: operator, allowLoopbackHttp: dependencies.allowLoopbackHttp },
  { ...dependencies, loadJwt: dependencies.loadJwt ?? loadOidcJwt });
  const customerVerifier = create(customerAudience, false), operatorVerifier = create(operatorAudience, true);
  const store = createPostgresAccountLinkStore({ connectionString: env.DATABASE_URL! });
  const authority = createPostgresOperatorIdentityStore({ connectionString: env.DATABASE_URL! });
  const emailTrustPolicy = createVerifierResultOnlyEmailTrustPolicy();
  const operatorAuthorization = createOperatorAdminAuth({ verifier: operatorVerifier, authority });
  const gateway = dependencies.customerGateway ?? createPostgresDataGateway({ connectionString: env.DATABASE_URL! });
  const customerProfile = { getCustomerMe: (principalId: string) => gateway.asActor({ role: "authenticated", sub: principalId },
    db => createPostgresCustomerMePort(db as PgGatewayClient).getCustomerMe(principalId)) };
  const reconcile = createReconcileAccountHandler({ verifier: customerVerifier, store, emailTrustPolicy });
  const me = createCustomerMeHandler({ responseSchema: customerMeResponseSchema, mePort: customerProfile,
    authenticateUser: req => authenticateCustomerUserWith(customerVerifier, readBearerToken(req)) });
  const routes: readonly RouteEntry[] = [
    { route: "/api/bff/customers/reconcile-account", handler: reconcile },
    { route: "/api/bff/customers/me", handler: me },
  ].map(route => ({ ...route, pattern: new RegExp(`^${route.route}$`), params: [], availability: "direct-postgres", handler: withObservedRoute({ route: route.route, domain: "identity", surface: "customer", risk: "mutation" },
    async (req, res) => { await route.handler(req, res); }) }));
  return { env, customerVerifier, operatorVerifier, operatorAuthorization, customerProfile, emailTrustPolicy, store, routes,
    /** Register with the existing reference identity admission seam. */
    oidcVerifiers: [customerVerifier, operatorVerifier] as readonly OidcIdentityVerifier[],
    async readiness() { return (await Promise.all([customerVerifier, operatorVerifier].map(identityOidcReadiness))).flat(); },
    async close() { await Promise.all([store.close(), authority.close()]); },
  };
}
