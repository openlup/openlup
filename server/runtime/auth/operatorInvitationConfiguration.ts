import { parseOperatorInvitationTtl } from "@openlup/platform/identity";
/** Parse before directory, persistence or notification side effects. */
export function readOperatorInvitationTtl(env: Record<string, string | undefined>): number {
  return parseOperatorInvitationTtl(env.OPERATOR_INVITATION_TTL_SECONDS);
}
