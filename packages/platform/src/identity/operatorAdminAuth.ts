import type { AdminAuthPort, IdentityVerifierPort } from "./ports.js";
import type { OperatorIdentityStore } from "./operatorPorts.js";
export function createOperatorAdminAuth(options: { verifier: IdentityVerifierPort; authority: Pick<OperatorIdentityStore, "findMembership"> }): AdminAuthPort {
  return { async authorize(token, restrictions) {
    const principal = token ? await options.verifier.verifyAccessToken(token) : null;
    if (!principal) return { ok: false, code: "UNAUTHORIZED", message: "Operator authentication required" };
    const member = await options.authority.findMembership(principal.principalId);
    if (!member || member.membershipState !== "active" || (member.role !== "admin" && member.role !== "distributor")
      || (restrictions?.allowedRoles && !restrictions.allowedRoles.includes(member.role))) {
      return { ok: false, code: "FORBIDDEN", message: "Operator access denied" };
    }
    return { ok: true, principalId: principal.principalId, role: member.role, isMachineActor: false };
  } };
}
