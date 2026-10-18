export function assertOperatorInvitationTtl(value: number): void {
  if (!Number.isInteger(value) || value < 60 || value > 2592000) throw new Error("operator_invitation_ttl_invalid");
}
export function invitationFailure(identityCode: string, bffCode = "CONFLICT"): Error & { identityCode: string; bffCode: string } {
  return Object.assign(new Error(identityCode), { identityCode, bffCode });
}

/** Pure parser; direct hosts call it before effects and pass the number to identity. */
export function parseOperatorInvitationTtl(raw?: string): number {
  if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error("operator_invitation_ttl_invalid");
  const value = raw === undefined ? 604800 : Number(raw);
  assertOperatorInvitationTtl(value);
  return value;
}
