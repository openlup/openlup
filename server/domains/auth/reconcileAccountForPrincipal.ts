import type { AccountLinkStore } from "./ports.js";

/**
 * Maps an authenticated principal onto a customer account — the inverse of
 * the legacy app `linkClientAuthUser` flow (which goes email → account → principal),
 * written generically against `AccountLinkStore`.
 *
 * Guarantees (the dedup contract):
 *  - A returning principal resolves to its existing account (idempotent).
 *  - A new principal whose verified email matches an *unlinked* account relinks
 *    to it (the primary dedup path — see plan Risk 1).
 *  - A brand-new principal gets an empty, fully-functional account.
 *  - An email already owned by a *different* principal is NEVER silently
 *    duplicated — it returns a typed conflict for the UI to surface.
 *  - No verified email (Facebook-no-email / unverified) never auto-provisions.
 */

export interface ReconcileAccountInput {
  principalId: string;
  email: string | null;
  emailVerified: boolean;
}

export type ReconcileAccountErrorCode =
  | "NO_VERIFIED_EMAIL"
  | "RESERVED_PRINCIPAL_REFUSED"
  | "PRINCIPAL_EMAIL_MISMATCH"
  | "ACCOUNT_LINK_CONFLICT"
  | "EMAIL_OWNED_BY_OTHER_PRINCIPAL";

export type ReconcileAccountResult =
  | { ok: true; accountId: string; created: boolean; linked: boolean }
  | { ok: false; code: ReconcileAccountErrorCode; existingPrincipalId?: string | null };

export async function reconcileAccountForPrincipal(
  store: AccountLinkStore,
  input: ReconcileAccountInput,
): Promise<ReconcileAccountResult> {
  const email = normalizeEmail(input.email);
  if (!email || !input.emailVerified) {
    return { ok: false, code: "NO_VERIFIED_EMAIL" };
  }

  // Reserved = MACHINE/service admin identities only. A human admin signing in
  // with their own verified email self-links to their matching unlinked client
  // via resolveByEmail → linkPrincipalToAccount below.
  if (await store.isReservedPrincipal(input.principalId)) {
    return { ok: false, code: "RESERVED_PRINCIPAL_REFUSED" };
  }

  const byPrincipal = await store.findAccountByPrincipalId(input.principalId);
  if (byPrincipal) {
    const accountEmail = normalizeEmail(byPrincipal.email);
    if (accountEmail && accountEmail !== email) {
      return { ok: false, code: "PRINCIPAL_EMAIL_MISMATCH", existingPrincipalId: input.principalId };
    }
    return { ok: true, accountId: byPrincipal.id, created: false, linked: false };
  }

  const viaEmail = await resolveByEmail(store, email, input.principalId);
  if (viaEmail) return viaEmail;

  // No account at all → provision a fresh empty (but fully functional) account.
  try {
    const created = await store.createAccount({
      email,
      principalId: input.principalId,
      acquisitionSource: "social_signup",
      lifecycleStage: "lead",
    });
    return { ok: true, accountId: created.id, created: true, linked: true };
  } catch (err) {
    // Unique-email race: a concurrent reconcile inserted first. Retry the email
    // branch once so we relink instead of failing the caller.
    const retry = await resolveByEmail(store, email, input.principalId);
    if (retry) return retry;
    throw err;
  }
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

async function resolveByEmail(
  store: AccountLinkStore,
  email: string,
  principalId: string,
): Promise<ReconcileAccountResult | null> {
  const account = await store.findAccountByEmail(email);
  if (!account) return null;

  if (account.principalId === principalId) {
    return { ok: true, accountId: account.id, created: false, linked: false };
  }
  if (account.principalId !== null) {
    return {
      ok: false,
      code: "EMAIL_OWNED_BY_OTHER_PRINCIPAL",
      existingPrincipalId: account.principalId,
    };
  }

  const link = await store.linkPrincipalToAccount(account.id, principalId);
  if (link.ok === true) {
    return { ok: true, accountId: account.id, created: false, linked: true };
  }
  return {
    ok: false,
    code: "ACCOUNT_LINK_CONFLICT",
    existingPrincipalId: link.existingPrincipalId,
  };
}
