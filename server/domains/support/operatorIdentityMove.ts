/**
 * Moving the authorization copy of a subject's address.
 *
 * The e-mail correction spans two systems: `clients.email` in Postgres and the
 * sign-in identity held by the auth service. `reconcileAccountForPrincipal`
 * compares them and answers `PRINCIPAL_EMAIL_MISMATCH` when they disagree, so a
 * correction that moves one copy alone does not merely fail to help - it turns an
 * undelivered magic link into a sign-in that is actively refused.
 *
 * Postgres cannot enforce that invariant because it cannot see the auth service's
 * half, which is why the routine that used to refuse every linked subject stopped
 * pretending to. The obligation lives here instead, in the one component that
 * holds both halves.
 *
 * This port is deliberately narrow. It is not the checkout-time account linking
 * port: that one exists to *find or create* an identity for a new customer, while
 * this one exists to *move* an existing one on an operator's explicit instruction.
 * Widening the linking port with this capability would hand checkout a verb it
 * must never call.
 */
export interface OperatorIdentityMovePort {
  /** The auth identity linked to this client row, or null when none is. */
  findLinkedIdentity(clientId: string): Promise<{ authUserId: string } | null>;
  /** The client row holding this address, if any. Used to refuse before mutating. */
  findClientHoldingEmail(email: string): Promise<{ clientId: string } | null>;
  /** Move the identity's address. Confirmed, so no verification mail is sent. */
  moveIdentityEmail(authUserId: string, email: string): Promise<void>;
}

/**
 * Decide and perform the identity half of an e-mail correction.
 *
 * Order is chosen for the failure mode. The address-already-taken refusal is by
 * far the most common one an operator hits, and it is knowable before any
 * mutation, so it is checked first and costs no auth write. Only then does the
 * identity move happen, and only then is the Postgres write attempted - so a
 * crash between the two leaves auth-moved/clients-stale, which the operator
 * repairs by retrying the same idempotent command. The reverse order has no such
 * repair: a failed identity move after a committed Postgres write leaves a
 * mismatch that nothing retries away.
 *
 * Returns whether the identity was moved, so the caller can say what it did
 * rather than infer it - and, when someone else is in the way, who that is. The
 * holder is already resolved here to make the decision above, so naming it costs
 * no extra read, and it is the one fact that turns `email_already_in_use` from a
 * dead end into the absorption that clears it.
 */
export async function moveIdentityForEmailCorrection(input: {
  port: OperatorIdentityMovePort;
  subjectId: string;
  newEmail: string;
}): Promise<{ moved: boolean; blockedByHolder: boolean; holderId: string | null }> {
  const holder = await input.port.findClientHoldingEmail(input.newEmail);
  if (holder && holder.clientId !== input.subjectId) {
    // Someone else holds the address. Let the authority answer
    // `email_already_in_use` from its own unique index rather than duplicating the
    // refusal here - but do not move the identity on the way to being refused, and
    // carry the holder out so the refusal can name a next step.
    return { moved: false, blockedByHolder: true, holderId: holder.clientId };
  }

  const identity = await input.port.findLinkedIdentity(input.subjectId);
  if (!identity) return { moved: false, blockedByHolder: false, holderId: null };

  await input.port.moveIdentityEmail(identity.authUserId, input.newEmail);
  return { moved: true, blockedByHolder: false, holderId: null };
}
