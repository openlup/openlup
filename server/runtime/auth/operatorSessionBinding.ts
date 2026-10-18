import { createPostgresOperatorIdentityStore, createOperatorSessionService, createCustomerSessionIssuer, createOperatorIdentityVerifier, createOperatorAdminAuth, createCapturedCustomerChallengeDelivery, createOperatorAuthHandlers, createMagicLinkOriginResolver, type CustomerChallengeDeliveryPort } from "@openlup/platform/identity";
import { padResponseTime } from "../../_lib/timing.js";
import type { HttpRequest } from "@openlup/platform/http";
type Env = Record<string, string | undefined>;
const loadJwt = () => import("jose");
function configuration(env: Env) {
  if (env.PLATFORM_BUNDLE !== "node-postgres" || !env.DATABASE_URL?.trim()) throw new Error("operator_identity_database_required");
  const audience = env.OPERATOR_IDENTITY_AUDIENCE ?? "";
  const customerAudience = env.CUSTOMER_IDENTITY_AUDIENCE ?? "";
  if (!audience || !customerAudience || audience === customerAudience) throw new Error("operator_audience_must_be_distinct");
  return { issuer: env.CUSTOMER_IDENTITY_ISSUER ?? "", audience, customerAudience, jwks: env.CUSTOMER_IDENTITY_JWKS ?? "" };
}
export function createOperatorHumanAuth(env: Env) {
  const config = configuration(env);
  const verifier = createOperatorIdentityVerifier(config, loadJwt);
  const store = createPostgresOperatorIdentityStore({ connectionString: env.DATABASE_URL! });
  return { ...createOperatorAdminAuth({ verifier, authority: store }), close: store.close };
}
export function createOperatorSessionBinding(env: Env, delivery: CustomerChallengeDeliveryPort = createCapturedCustomerChallengeDelivery()) {
  const config = configuration(env);
  // Validate the verifier configuration as well as signing configuration before issuing a challenge.
  createOperatorIdentityVerifier(config, loadJwt);
  const issuer = createCustomerSessionIssuer({ ...config, keyId: env.CUSTOMER_IDENTITY_KEY_ID ?? "", privateJwk: env.CUSTOMER_IDENTITY_PRIVATE_JWK ?? "", ttlSeconds: 900 }, loadJwt);
  const origin = createMagicLinkOriginResolver([env.APP_BASE_URL?.trim() || env.SITE_URL?.trim() || ""])({} as HttpRequest);
  if (!origin) throw new Error("operator_identity_origin_required");
  const store = createPostgresOperatorIdentityStore({ connectionString: env.DATABASE_URL! });
  const sessions = createOperatorSessionService({ store, issuer, delivery, deliveryFailed: code => console.warn(code) });
  const handlers = createOperatorAuthHandlers({ sessions, origin, padResponseTime, messages: {
    invalidRequest: "Invalid operator authentication request", forbidden: "Same-origin JSON required",
    unauthorized: "Operator challenge invalid or expired", unavailable: "Operator authentication unavailable",
  } });
  return { ...handlers, close: store.close };
}
