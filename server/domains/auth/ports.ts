// Generic server-side auth ports. OSS core: no provider client, secrets, or
// brand literals. The product app supplies concrete adapters outside this domain.

import type { EmailBlock } from "../../../src/domains/communications/email/blocks.js";
import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";

export type AuthEmailLocale = Locale;

/** Typed refusal used by public/default composition when product copy is absent. */
export class AuthEmailContentUnavailableError extends Error {
  readonly code = "auth_email_content_unavailable";

  constructor() {
    super("Auth email content unavailable");
    this.name = "AuthEmailContentUnavailableError";
  }
}

export interface AuthEmailContentPort {
  buildAuthEmailContent(input: {
    actionType: string;
    userMetadata: Record<string, unknown> | null | undefined;
    redirectTo: string;
    actionLink: string;
    otp: string | null;
  }): {
    locale: AuthEmailLocale;
    subject: string;
    preheader: string;
    blocks: EmailBlock[];
  };
}

export type AuthEmailPersistenceSkipReason = "admin_disabled" | "egress_suppressed";

export interface AuthEmailMessage {
  sender: string;
  recipient: string;
  subject: string;
  html: string;
  text?: string;
}

export interface AuthEmailTransportResult {
  outcome: {
    ok: boolean;
    messageId: string | null;
    providerError: string | null;
    aborted?: boolean;
    adminDisabled?: boolean;
    suppressed?: "drop" | null;
    egressMode?: "production" | "sandbox_direct" | "sandbox_sink" | "drop";
  };
  providerResponse: Record<string, unknown>;
}

/** Provider-neutral outbound seam supplied by the API composition root. */
export interface AuthEmailTransportPort {
  readonly providerKind: string;
  send(message: AuthEmailMessage): Promise<AuthEmailTransportResult>;
}

/** Provider-neutral send observation owned by the Auth email candidate. */
export interface AuthEmailPersistencePort {
  isTemplateEnabled(templateSlug: string, signal: AbortSignal): Promise<boolean>;
  recordSend(input: {
    templateSlug: string;
    recipientEmail: string;
    authUserId: string | null;
    aggregateId: string;
    dedupeKey: string;
    providerKind: string;
    outcome: {
      ok: boolean;
      messageId: string | null;
      providerError: string | null;
      aborted?: boolean;
      skipReason?: AuthEmailPersistenceSkipReason | null;
    };
    providerResponse: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/** The principal an access token resolves to, plus its email verification state. */
export interface VerifiedPrincipal {
  principalId: string;
  email: string | null;
  emailVerified: boolean;
}

/** Verifies an opaque bearer/access token and yields the authenticated principal. */
export interface IdentityVerifierPort {
  verifyAccessToken(accessToken: string): Promise<VerifiedPrincipal | null>;
}

export interface CustomerChallengeStore {
  issue(input: {
    email: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<{ deliverable: boolean }>;
  redeem(input: { tokenHash: string; now: string }): Promise<{
    principalId: string;
    email: string;
  } | null>;
}

export interface CustomerChallengeDeliveryPort {
  deliver(input: { email: string; token: string; expiresAt: string }): Promise<void>;
}

export interface CustomerSessionIssuerPort {
  issue(input: { principalId: string; email: string }): Promise<{
    accessToken: string;
    expiresAt: string;
  }>;
}

/** Neutral soft-account linking policy. Provider administration belongs to an adapter. */
export type LinkClientAuthUserResult =
  | {
      ok: true;
      clientId: string;
      authUserId: string;
      created: boolean;
      alreadyLinked: boolean;
      adminSelfLink: boolean;
    }
  | {
      ok: false;
      code: "CLIENT_NOT_FOUND" | "MACHINE_ACTOR_REFUSED" | "CLIENT_AUTH_LINK_CONFLICT";
      message: string;
    };

export type SetClientAuthUserIdResult =
  | { ok: true; alreadyLinked: boolean }
  | { ok: false; code: "CLIENT_AUTH_LINK_CONFLICT"; existingAuthUserId: string | null };

export interface ClientAuthLinkStore {
  findClientByEmail(email: string): Promise<{ id: string; authUserId: string | null } | null>;
  findAuthUserIdByEmail(email: string): Promise<string | null>;
  findAuthUserEmailById(authUserId: string): Promise<string | null>;
  createAuthUser(email: string): Promise<string>;
  findAdminIdentity(authUserId: string): Promise<{ isMachineActor: boolean } | null>;
  setClientAuthUserId(clientId: string, authUserId: string): Promise<SetClientAuthUserIdResult>;
}

export async function linkClientAuthUser(
  store: ClientAuthLinkStore,
  rawEmail: string,
): Promise<LinkClientAuthUserResult> {
  const email = rawEmail.trim().toLowerCase();
  const client = await store.findClientByEmail(email);
  if (!client) return { ok: false, code: "CLIENT_NOT_FOUND", message: "No client row exists for this email; provision the client first." };

  if (client.authUserId) {
    const linkedEmail = await store.findAuthUserEmailById(client.authUserId);
    if (linkedEmail?.trim().toLowerCase() !== email) {
      return { ok: false, code: "CLIENT_AUTH_LINK_CONFLICT", message: "Client account is linked to a different auth identity." };
    }
    return { ok: true, clientId: client.id, authUserId: client.authUserId, created: false, alreadyLinked: true, adminSelfLink: false };
  }

  let authUserId = await store.findAuthUserIdByEmail(email);
  let created = false;
  if (!authUserId) {
    authUserId = await store.createAuthUser(email);
    created = true;
  }
  const adminIdentity = await store.findAdminIdentity(authUserId);
  if (adminIdentity?.isMachineActor) {
    return { ok: false, code: "MACHINE_ACTOR_REFUSED", message: "Refusing to link a machine/service admin identity to a customer client row." };
  }
  const link = await store.setClientAuthUserId(client.id, authUserId);
  if (!link.ok) {
    return { ok: false, code: "CLIENT_AUTH_LINK_CONFLICT", message: "Client account was linked to another auth identity concurrently." };
  }
  return { ok: true, clientId: client.id, authUserId, created, alreadyLinked: link.alreadyLinked, adminSelfLink: adminIdentity !== null };
}

/** Admin roles recognized by the authorization spine. */
export type AdminPrincipalRole = "admin" | "distributor";

/**
 * Outcome of admin authorization. UUID-keep: `principalId` is the auth uuid
 * (the same value an `EXISTS(admin_users WHERE id = auth.uid())` RLS check
 * resolves), and `isMachineActor` is re-derived from the admin store row — never
 * trusted from the caller.
 */
export type AdminAuthorizationResult =
  | { ok: true; principalId: string; role: AdminPrincipalRole; isMachineActor: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };

/**
 * Authorizes an admin access token: verifies the token, then re-derives the
 * admin role + machine-actor flag from the governing store. The product adapter
 * maps these onto `admin_users` over the user-scoped product client, preserving
 * the existing RLS-equivalent `auth.uid()` semantics.
 */
export interface AdminAuthPort {
  authorize(
    accessToken: string | null,
    options?: { allowedRoles?: readonly AdminPrincipalRole[] },
  ): Promise<AdminAuthorizationResult>;
}

/** A customer account as the reconcile logic needs it — not a vendor row shape. */
export interface CustomerAccount {
  id: string;
  /** The canonical account email used to verify principal/account consistency. */
  email: string | null;
  /** The auth principal currently linked to this account, or null if unlinked. */
  principalId: string | null;
}

export interface CreateAccountInput {
  email: string;
  principalId: string;
  acquisitionSource: string;
  lifecycleStage: string;
}

export type LinkPrincipalResult =
  | { ok: true; alreadyLinked: boolean }
  | { ok: false; existingPrincipalId: string | null };

/**
 * Account-linking store the reconcile logic drives. The product adapter maps these
 * onto the `clients` table (+ `admin_users` for `isReservedPrincipal`).
 */
export interface AccountLinkStore {
  findAccountByPrincipalId(principalId: string): Promise<CustomerAccount | null>;
  findAccountByEmail(email: string): Promise<CustomerAccount | null>;
  /**
   * True if the principal must never own a customer account — reserved for
   * MACHINE/service admin identities only. A human admin whose verified email
   * matches an unlinked account is allowed to self-link (they are linking their
   * own identity), so this returns false for them.
   */
  isReservedPrincipal(principalId: string): Promise<boolean>;
  /** Atomically link only when currently unlinked; reports conflict otherwise. */
  linkPrincipalToAccount(accountId: string, principalId: string): Promise<LinkPrincipalResult>;
  createAccount(input: CreateAccountInput): Promise<{ id: string }>;
}
