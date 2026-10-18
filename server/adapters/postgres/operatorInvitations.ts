import { createDirectOperatorInvitationStore } from "@openlup/platform/identity";
import type { PostgresDataGatewayEnv, PostgresDataGatewayOptions } from "@openlup/platform/data";
/** Trusted direct human-login continuation; never bound to machine auth. */
export function createPostgresOperatorInvitations(env: PostgresDataGatewayEnv, options: PostgresDataGatewayOptions = {}) {
  return createDirectOperatorInvitationStore(env, options);
}
