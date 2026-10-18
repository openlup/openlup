// Reuse the reference host's real SDK constructors and their production client options.
import { createCustomerClient, createCustomerServiceClient } from "../../server/_lib/customer-domain/auth.js";
import { createCustomerMagicLinkHandler } from "@openlup/platform/identity";
import { customerMagicLinkRequestSchema, customerMagicLinkResponseSchema } from "../../src/domains/customers/contracts.js";
import { checkAndRecordCustomerMagicLinkAttempt, extractClientIp } from "../../server/_lib/rate-limit/customerMagicLinkRateLimit.js";
import { padResponseTime } from "../../server/_lib/timing.js";
import { resolveCustomerSessionBinding } from "../../server/runtime/customers/customerSessionBinding.js";

// Same package engine, schemas, SDK clients, quota and padding as the customer route.
export function createEnvelopeCustomerMagicLink(env: { url: string; anonKey: string; serviceRoleKey: string; origin: string }) {
  return createCustomerMagicLinkHandler({
    enabled: () => true, env: { PLATFORM_BUNDLE: "node-supabase" },
    requestSchema: customerMagicLinkRequestSchema, responseSchema: customerMagicLinkResponseSchema,
    readEnvironment: () => env, createCustomerClient, createCustomerServiceClient,
    checkAttempt: checkAndRecordCustomerMagicLinkAttempt, extractClientIp, padResponseTime,
    redirectOrigins: [env.origin], callbackPath: () => "/account/auth/callback", resolveSession: resolveCustomerSessionBinding,
  });
}
export function createEnvelopeClients(env: { url: string; anonKey: string; serviceRoleKey: string }) {
  return { actor: createCustomerClient(env, null), service: createCustomerServiceClient(env) };
}
// CLI-supported provider with dummy local credentials. Never initiate an OAuth flow.
export const externalProviderFixture = {
  id: "github",
  config: '\n[auth.external.github]\nenabled = true\nclient_id = "synthetic-local-client"\nsecret = "synthetic-local-secret"\n',
};
