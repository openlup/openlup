export interface VerifiedPrincipal {
  principalId: string;
  email: string | null;
  emailVerified: boolean;
}


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
  /** Provision an unconfirmed principal; null means an existing identity needs lookup. */
  createAuthUser(email: string): Promise<string | null>;
  findAdminIdentity(authUserId: string): Promise<{ isMachineActor: boolean } | null>;
  setClientAuthUserId(clientId: string, authUserId: string): Promise<SetClientAuthUserIdResult>;
}

/** Link a commerce contact without proving mailbox ownership; failed links never delete identities. */
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

  const { authUserId, created } = await findOrCreateAuthUserId(store, email);
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


export type AdminPrincipalRole = "admin" | "distributor";


export type AdminAuthorizationResult =
  | { ok: true; principalId: string; role: AdminPrincipalRole; isMachineActor: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };


export interface AdminAuthPort {
  authorize(
    accessToken: string | null,
    options?: { allowedRoles?: readonly AdminPrincipalRole[] },
  ): Promise<AdminAuthorizationResult>;
}


export interface CustomerAccount {
  id: string;
  
  email: string | null;
  
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


export interface AccountLinkStore {
  findAccountByPrincipalId(principalId: string): Promise<CustomerAccount | null>;
  findAccountByEmail(email: string): Promise<CustomerAccount | null>;
  
  isReservedPrincipal(principalId: string): Promise<boolean>;
  
  linkPrincipalToAccount(accountId: string, principalId: string): Promise<LinkPrincipalResult>;
  createAccount(input: CreateAccountInput): Promise<{ id: string }>;
}

/** Attempt creation before scanning the existing identity directory. */
export async function findOrCreateAuthUserId(
  store: Pick<ClientAuthLinkStore, "createAuthUser" | "findAuthUserIdByEmail">,
  email: string,
): Promise<{ authUserId: string; created: boolean }> {
  const createdId = await store.createAuthUser(email);
  if (createdId) return { authUserId: createdId, created: true };
  const existingId = await store.findAuthUserIdByEmail(email);
  if (!existingId) throw new Error("auth_user_registered_but_unresolved");
  return { authUserId: existingId, created: false };
}
