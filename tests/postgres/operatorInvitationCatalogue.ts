const invitationForward = "db/platform/migrations/20261018120000_identity_operator_invitations.sql";

/** Select the complete history before invitations, regardless of later forwards. */
export function invitationPredecessor<T extends { file: string }>(forward: readonly T[]): T[] {
  const position = forward.findIndex(entry => entry.file === invitationForward);
  if (position < 0) throw new Error("Operator invitation forward is missing from the catalogue");
  return forward.slice(0, position);
}
