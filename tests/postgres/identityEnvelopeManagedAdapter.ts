// Reuse the reference host's real SDK constructors and their production client options.
import { createCustomerClient, createCustomerServiceClient } from "../../server/_lib/customer-domain/auth.js";
export function createEnvelopeClients(env: { url: string; anonKey: string; serviceRoleKey: string }) {
  return { actor: createCustomerClient(env, null), service: createCustomerServiceClient(env) };
}
// CLI-supported provider with dummy local credentials. Never initiate an OAuth flow.
export const externalProviderFixture = {
  id: "github",
  config: '\n[auth.external.github]\nenabled = true\nclient_id = "synthetic-local-client"\nsecret = "synthetic-local-secret"\n',
};
