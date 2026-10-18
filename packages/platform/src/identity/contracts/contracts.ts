export const AUTH_RECONCILE_CONTRACT_VERSION = "auth.reconcile.v1" as const;
export interface AuthReconcileResponse {
  accountId: string;
  created: boolean;
  linked: boolean;
}
export type AuthReconcileErrorCode =
  | "NO_VERIFIED_EMAIL"
  | "RESERVED_PRINCIPAL_REFUSED"
  | "ACCOUNT_LINK_CONFLICT"
  | "EMAIL_OWNED_BY_OTHER_PRINCIPAL";
// Runtime schemas remain in reference composition until the validator boundary is resolved.
