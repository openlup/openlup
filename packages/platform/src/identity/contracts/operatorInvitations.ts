/** Pending invitations confer no authority; only accepted native memberships do. */
export type OperatorRole = "admin" | "distributor";
export type OperatorMembershipState = "invited" | "active" | "expired" | "revoked";
export type OperatorInvitationOutcome = "INVITATION_CREATED" | "ALREADY_INVITED" | "INVITATION_REISSUED";
export type OperatorInvitationConflict = "MEMBERSHIP_ALREADY_ACTIVE" | "INVITATION_ROLE_CONFLICT" | "IDENTITY_CONFLICT" | "MANAGED_REINVITE_UNSUPPORTED";
export interface OperatorInvitation {
  principalId: string;
  invitationId: string;
  membershipState: "invited";
  role: OperatorRole;
  invitedAt: string;
  expiresAt: string;
}
export interface OperatorInvitationResult extends OperatorInvitation { code: OperatorInvitationOutcome; message?: string }
export interface OperatorMembershipSnapshot {
  principalId: string;
  membershipState: OperatorMembershipState;
  role: OperatorRole;
}
export type OperatorInvitationAcceptance =
  | { code: "ACTIVATED" | "ALREADY_ACTIVE"; role: OperatorRole }
  | { code: "INVITATION_EXPIRED" | "INVITATION_REVOKED" | "NO_INVITATION" };

/** Managed invitations activate membership immediately; no pending attempt is stored. */
export interface ManagedOperatorMembershipResult {
  principalId: string;
  membershipState: "active";
  role: OperatorRole;
  code: "MEMBERSHIP_CREATED" | "ALREADY_ACTIVE";
  message?: string;
}
export type OperatorInviteResult = OperatorInvitationResult | ManagedOperatorMembershipResult;
