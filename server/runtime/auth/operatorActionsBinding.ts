import {
  createDirectOperatorIdentityDirectory, createDirectOperatorInvitationStore,
  createAdminUserInvitePort, createAdminUserRemovePort, runInviteAdminUserUseCase,
  runRemoveAdminUserUseCase, parseOperatorInvitationTtl,
  type AdminRoleNotificationPort, type InviteAdminUserGateway,
} from "@openlup/platform/identity";
import { createOperatorHumanAuth } from "./operatorSessionBinding.js";

type Env = Record<string, string | undefined>;
export type DirectOperatorActionOptions = {
  notification?: AdminRoleNotificationPort;
  createAuth?: typeof createOperatorHumanAuth;
  createDirectory?: typeof createDirectOperatorIdentityDirectory;
  createStore?: typeof createDirectOperatorInvitationStore;
};
/** Use the existing lifecycle in its owner lane; authentication never supplies a stored role. */
export function createDirectOperatorActionsBinding(env: Env, accessToken: string | null, options: DirectOperatorActionOptions = {}) {
  if (env.PLATFORM_BUNDLE !== "node-postgres" || !env.DATABASE_URL?.trim()) throw new Error("operator_identity_database_required");
  const ttlSeconds = parseOperatorInvitationTtl(env.OPERATOR_INVITATION_TTL_SECONDS);
  const siteUrl = env.APP_BASE_URL ?? env.SITE_URL ?? "";
  const database = { connectionString: env.DATABASE_URL };
  const auth = (options.createAuth ?? createOperatorHumanAuth)(env);
  const directory = (options.createDirectory ?? createDirectOperatorIdentityDirectory)(database);
  const store = (options.createStore ?? createDirectOperatorInvitationStore)(database);
  const authorizeAdmin = () => auth.authorize(accessToken, { allowedRoles: ["admin"] });
  const gateway: InviteAdminUserGateway = {
    async getUser(token) {
      const result = await auth.authorize(token, { allowedRoles: ["admin"] });
      return { user: result.ok ? { id: result.principalId } : null, error: result.ok ? null : result.code };
    },
    async findAdminUser(id) {
      const member = await store.read(id);
      return member ? { id, role: member.role, membership_state: member.membershipState, is_machine_actor: false } : null;
    },
    // Principal lookup/creation and collision protection belong to the existing directory/store.
    findAdminUserByEmail: async () => null,
    findAuthUserByEmail: async () => null,
    async inviteAuthUser(input) {
      const result = await directory.ensurePrincipal(input);
      return { user: { id: result.principalId }, error: null };
    },
  };
  const notification = options.notification ?? { sendRoleGranted: async () => { throw new Error("operator_notification_required"); } };
  return {
    authorizeAdmin,
    invitePort: createAdminUserInvitePort({ accessToken, runInviteAdminUser: request => runInviteAdminUserUseCase(request, {
      gateway, invitationStore: store, ttlSeconds, siteUrl, roleNotificationPort: notification,
    }) }),
    removePort: createAdminUserRemovePort({ accessToken, runRemoveAdminUser: request => runRemoveAdminUserUseCase(request, {
      getUser: gateway.getUser, findAdminUser: gateway.findAdminUser,
      revokeAdminUser: async () => { throw new Error("direct_invitation_store_required"); },
    }, undefined, store) }),
    async close() { await Promise.all([auth.close(), directory.close(), store.close()]); },
  };
}
