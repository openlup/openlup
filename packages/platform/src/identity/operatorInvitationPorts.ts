import type { OperatorInvitationAcceptance, OperatorInvitationConflict, OperatorInvitationResult, OperatorMembershipSnapshot, OperatorRole } from "./contracts/operatorInvitations.js";
export interface OperatorIdentityDirectoryPort {
  ensurePrincipal(input: { email: string; redirectTo: string }): Promise<{ principalId: string; created: boolean }>;
}
export interface OperatorInvitationStore {
  issue(input: { actorPrincipalId: string; targetPrincipalId: string; email: string; role: OperatorRole; ttlSeconds: number }): Promise<OperatorInvitationResult | { code: OperatorInvitationConflict }>;
  read(principalId: string): Promise<OperatorMembershipSnapshot | null>;
  /** Trusted server input only: principal must come from successful authentication. */
  acceptOperatorInvitation(principalId: string): Promise<OperatorInvitationAcceptance>;
  remove(input: { actorPrincipalId: string; targetPrincipalId: string; reason?: string }): Promise<{ revoked: true }>;
}
