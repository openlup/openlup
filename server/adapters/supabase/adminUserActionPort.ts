import type { AdminSettingsPort } from "../../../src/domains/platform/ports.js";
import { readEmailOriginConfiguration, resolveEmailOrigin, type EmailOriginResolution } from "../../../src/domains/communications/email/originPolicy.js";
import { APP_PRODUCTION_EMAIL_HOSTS, APP_SITE_ORIGIN } from "../../../src/lib/brand/appBrand.js";
import { readHiddenPreviewEnabled, readObservedEnvironment } from "../../_lib/observability/environment.js";
import { createAdminAuthClient, createServiceRoleClient, resolveSupabaseAdminAuthEnv, resolveSupabaseServiceRoleEnv } from "../../_lib/admin-domain/auth.js";
import { createAdminRoleNotificationPort, type AdminRoleNotificationClient } from "../email/adminRoleNotificationPort.js";
import { runInviteAdminUserUseCase, type AdminRoleNotificationPort, type InviteAdminUserGateway } from "../../domains/platform/inviteAdminUserUseCase.js";
import { runRemoveAdminUserUseCase, type RemoveAdminUserGateway } from "../../domains/platform/removeAdminUserUseCase.js";
import { createResendTransport as createEmailTransport } from "../../infra/email/emailTransport.js";

export const DEFAULT_ADMIN_ROLE_FROM_EMAIL = "OPENLUP <noreply@openlup.com>";

export type AdminUserActionRuntimeEnv = Record<string, string | undefined> & {
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  APP_BASE_URL?: string;
  CUSTOMER_AUTH_REDIRECT_ORIGIN?: string;
  SITE_URL?: string;
  EMAIL_ENVIRONMENT?: string;
  EMAIL_DEFAULT_ORIGIN?: string;
  EMAIL_PRODUCTION_ORIGIN_HOSTS?: string;
  HIDDEN_SANDBOX_PREVIEW_ENABLED?: string;
  FROM_EMAIL?: string;
};

export type AdminUserInviteRunner = (
  request: { accessToken: string | null; email: string; role: "admin" | "distributor" },
  env?: AdminUserActionRuntimeEnv,
) => ReturnType<typeof runInviteAdminUserUseCase>;

export type AdminUserRemoveRunner = (
  request: { accessToken: string | null; userId: string },
  env?: AdminUserActionRuntimeEnv,
) => ReturnType<typeof runRemoveAdminUserUseCase>;

interface InviteAdminUserQuery {
  select(columns: string): {
    eq(column: string, value: string): {
      maybeSingle(): PromiseLike<{ data: { id: string; role?: string } | null }>;
    };
  };
  insert(row: { id: string; email: string; role: "admin" | "distributor" }):
    PromiseLike<{ error: { message: string } | null }>;
}

export interface InviteAdminUserClient {
  auth: {
    getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
    admin: {
      listUsers(): PromiseLike<{ data: { users: Array<{ id: string; email?: string | null }> } | null }>;
      inviteUserByEmail(
        email: string,
        options: { redirectTo: string; data: Record<string, unknown> },
      ): PromiseLike<{
        data: { user: { id: string } | null };
        error: { message: string } | null;
      }>;
    };
  };
  from(table: "admin_users"): InviteAdminUserQuery;
  rpc?: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

interface RemoveAdminUserQuery {
  select(columns: string): {
    eq(column: string, value: string): RemoveAdminUserQueryResult;
  };
}

interface RemoveAdminUserQueryResult {
  eq(column: string, value: string): RemoveAdminUserQueryResult;
  maybeSingle(): PromiseLike<{ data: { id: string; role: string } | null; error: { message: string } | null }>;
}

export interface RemoveAdminUserClient {
  auth: {
    getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
  };
  from(table: "admin_users"): RemoveAdminUserQuery;
  rpc(
    fn: "admin_revoke_admin_user",
    args: { p_target: string; p_reason: string | null },
  ): PromiseLike<{ error: { message: string } | null }>;
}

export function createSupabaseAdminUserInvitePort(options: {
  accessToken: string | null;
  env?: AdminUserActionRuntimeEnv;
  runInviteAdminUser?: AdminUserInviteRunner;
}): Pick<AdminSettingsPort, "inviteAdminUser"> {
  const runInviteAdminUser = options.runInviteAdminUser ?? runInviteAdminUserHandler;
  return {
    async inviteAdminUser(request) {
      const result = await runInviteAdminUser({
        accessToken: options.accessToken,
        email: request.email,
        role: request.role,
      }, options.env);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(String(result.body.error ?? `invite_admin_user_http_${result.status}`));
      }
      if (result.body.error) throw new Error(result.body.error);

      return { message: result.body.message };
    },
  };
}

export function createSupabaseAdminUserRemovePort(options: {
  accessToken: string | null;
  env?: AdminUserActionRuntimeEnv;
  runRemoveAdminUser?: AdminUserRemoveRunner;
}): Pick<AdminSettingsPort, "removeAdminUser"> {
  const runRemoveAdminUser = options.runRemoveAdminUser ?? runRemoveAdminUserHandler;
  return {
    async removeAdminUser(request) {
      const result = await runRemoveAdminUser({
        accessToken: options.accessToken,
        userId: request.userId,
      }, options.env);
      if (result.status < 200 || result.status >= 300) {
        throw removePortError(
          result.status,
          String(result.body.error ?? `remove_admin_user_http_${result.status}`),
        );
      }
      if (result.body.error) throw new Error(result.body.error);

      if (result.body.revoked !== true) {
        throw new Error("admin_revoke_admin_user returned an invalid response");
      }
      return { revoked: true };
    },
  };
}

export const runInviteAdminUserHandler: AdminUserInviteRunner = async (request, env = process.env) => {
  const config = resolveSupabaseServiceRoleEnv(env);
  if (!config) return { status: 500, body: { error: "supabase_service_role_not_configured" } };

  const origin = resolveInviteAdminEmailOrigin(env);
  if (origin.ok === false) {
    throw new Error(`invite-admin-user email origin policy failed: ${origin.error}`);
  }
  const siteUrl = origin.origin;
  let client: InviteAdminUserClient | null = null;
  let notificationPort: AdminRoleNotificationPort | null = null;
  const getClient = () => {
    client ??= createServiceRoleClient({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
    }) as unknown as InviteAdminUserClient;
    return client;
  };
  const getNotificationPort = () => {
    notificationPort ??= createAdminRoleNotificationPort({
      client: getClient() as unknown as AdminRoleNotificationClient,
      transport: createEmailTransport({ apiKey: env.RESEND_API_KEY ?? "", env }),
      fromEmail: resolveInviteAdminFromEmail(env),
      siteUrl,
      emailOriginSource: origin.source,
      emailEnvironment: origin.resolved.environment,
    });
    return notificationPort;
  };

  const result = await runInviteAdminUserUseCase(request, {
    gateway: createInviteAdminUserGateway(getClient),
    roleNotificationPort: {
      sendRoleGranted: (notification) => getNotificationPort().sendRoleGranted(notification),
    },
    siteUrl,
  });
  return toInviteAdminWireResult(result);
};

export function toInviteAdminWireResult(
  result: Awaited<ReturnType<typeof runInviteAdminUserUseCase>>,
): Awaited<ReturnType<typeof runInviteAdminUserUseCase>> {
  const { deliveryReference, deliveryReferencePresent, ...body } = result.body;
  if (deliveryReference === undefined && deliveryReferencePresent === undefined) return result;
  return {
    status: result.status,
    body: { ...body, resendId: deliveryReference, resendIdPresent: deliveryReferencePresent },
  };
}

export function createInviteAdminUserGateway(clientFactory: () => InviteAdminUserClient): InviteAdminUserGateway {
  let client: InviteAdminUserClient | null = null;
  const getClient = (): InviteAdminUserClient => client ??= clientFactory();

  return {
    async getUser(accessToken) {
      const { data, error } = await getClient().auth.getUser(accessToken);
      return { user: data?.user ?? null, error };
    },
    async findAdminUser(userId) {
      const { data } = await getClient()
        .from("admin_users")
        .select("id, role")
        .eq("id", userId)
        .maybeSingle();
      return data && typeof data.role === "string" ? { id: data.id, role: data.role } : null;
    },
    async findAdminUserByEmail(email) {
      const { data } = await getClient()
        .from("admin_users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      return data ? { id: data.id } : null;
    },
    async listAuthUsers() {
      const { data } = await getClient().auth.admin.listUsers();
      return data?.users ?? [];
    },
    async insertAdminUser(input) {
      return await getClient().from("admin_users").insert(input);
    },
    async inviteAuthUser(input) {
      const { data, error } = await getClient().auth.admin.inviteUserByEmail(input.email, {
        redirectTo: input.redirectTo,
        data: { admin_invite_role: input.role },
      });
      return { user: data.user, error };
    },
  };
}

export const runRemoveAdminUserHandler: AdminUserRemoveRunner = async (request, env = process.env) => {
  const config = resolveSupabaseAdminAuthEnv(env);
  if (!config) return { status: 500, body: { error: "supabase_user_auth_not_configured" } };

  return runRemoveAdminUserUseCase(request, createRemoveAdminUserGateway(() => (
    createAdminAuthClient({
      url: config.url,
      anonKey: config.anonKey,
    }, request.accessToken) as unknown as RemoveAdminUserClient
  )));
};

export function createRemoveAdminUserGateway(clientFactory: () => RemoveAdminUserClient): RemoveAdminUserGateway {
  let client: RemoveAdminUserClient | null = null;
  const getClient = (): RemoveAdminUserClient => client ??= clientFactory();

  return {
    async getUser(accessToken) {
      const { data, error } = await getClient().auth.getUser(accessToken);
      return { user: data?.user ?? null, error };
    },
    async findAdminUser(userId) {
      const { data, error } = await getClient()
        .from("admin_users")
        .select("id, role")
        .eq("id", userId)
        .eq("membership_state", "active")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async revokeAdminUser(userId) {
      return await getClient().rpc("admin_revoke_admin_user", {
        p_target: userId,
        p_reason: null,
      });
    },
  };
}

function removePortError(status: number, message: string): Error {
  const bffCode = ({ 400: "BAD_REQUEST", 403: "FORBIDDEN", 409: "CONFLICT" } as const)[status]
    ?? "UPSTREAM_UNAVAILABLE";
  return Object.assign(new Error(message), { bffCode });
}

export function resolveInviteAdminEmailOrigin(env: AdminUserActionRuntimeEnv): EmailOriginResolution {
  return resolveEmailOrigin({
    ...readEmailOriginConfiguration(env, {
      defaultOrigin: APP_SITE_ORIGIN,
      productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS,
    }),
    explicitBaseUrl: env.APP_BASE_URL?.trim() || env.openlup_BASE_URL,
    customerAuthRedirectOrigin: env.CUSTOMER_AUTH_REDIRECT_ORIGIN,
    siteUrl: env.SITE_URL,
    hiddenPreviewEnabled: readHiddenPreviewEnabled(env),
    environment: env.EMAIL_ENVIRONMENT ?? readObservedEnvironment(env),
  });
}

export function resolveInviteAdminFromEmail(env: AdminUserActionRuntimeEnv): string {
  return env.FROM_EMAIL || DEFAULT_ADMIN_ROLE_FROM_EMAIL;
}
