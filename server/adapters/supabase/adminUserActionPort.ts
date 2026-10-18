import { createAdminUserInvitePort, createAdminUserRemovePort } from "@openlup/platform/identity";
import { createInviteAdminUserGateway, createRemoveAdminUserGateway } from "@openlup/platform/identity";
export { createInviteAdminUserGateway, createRemoveAdminUserGateway } from "@openlup/platform/identity";
import type { InviteAdminUserClient, RemoveAdminUserClient } from "@openlup/platform/identity";
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

export function createSupabaseAdminUserInvitePort(options: { accessToken: string | null; env?: AdminUserActionRuntimeEnv; runInviteAdminUser?: AdminUserInviteRunner }) {
  return createAdminUserInvitePort({ ...options, runInviteAdminUser: options.runInviteAdminUser ?? runInviteAdminUserHandler });
}
export function createSupabaseAdminUserRemovePort(options: { accessToken: string | null; env?: AdminUserActionRuntimeEnv; runRemoveAdminUser?: AdminUserRemoveRunner }) {
  return createAdminUserRemovePort({ ...options, runRemoveAdminUser: options.runRemoveAdminUser ?? runRemoveAdminUserHandler });
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

export function resolveInviteAdminEmailOrigin(env: AdminUserActionRuntimeEnv): EmailOriginResolution {
  return resolveEmailOrigin({
    ...readEmailOriginConfiguration(env, {
      defaultOrigin: APP_SITE_ORIGIN,
      productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS,
    }),
    explicitBaseUrl: env.APP_BASE_URL?.trim() || env.OPENLUP_BASE_URL,
    customerAuthRedirectOrigin: env.CUSTOMER_AUTH_REDIRECT_ORIGIN,
    siteUrl: env.SITE_URL,
    hiddenPreviewEnabled: readHiddenPreviewEnabled(env),
    environment: env.EMAIL_ENVIRONMENT ?? readObservedEnvironment(env),
  });
}

export function resolveInviteAdminFromEmail(env: AdminUserActionRuntimeEnv): string {
  return env.FROM_EMAIL || DEFAULT_ADMIN_ROLE_FROM_EMAIL;
}
