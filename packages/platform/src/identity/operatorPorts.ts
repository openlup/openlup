export interface OperatorIdentity { principalId: string; email: string }
export interface OperatorMembership extends OperatorIdentity { membershipState: string; role: unknown }
export interface OperatorIdentityStore {
  issue(input: { email: string; tokenHash: string }): Promise<{ deliverable: false } | { deliverable: true; email: string; expiresAt: string }>;
  /** Activation and consumption commit together before signing. */
  redeem(input: { tokenHash: string }): Promise<OperatorIdentity | null>;
  findMembership(principalId: string): Promise<OperatorMembership | null>;
  bootstrapFirstAdministrator(input: { email: string }): Promise<{ principalId: string; membershipState: "invited" }>;
  pruneChallenges(input: { limit: number }): Promise<{ deleted: number }>;
  close(): Promise<void>;
}
