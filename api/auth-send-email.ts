/**
 * The live target of the Supabase Auth Send Email hook in staging and production.
 *
 * The hooks were repointed here on 2026-09-04; `scripts/configure-auth-email-hook.ts`
 * sets that target. This endpoint is intentionally public-but-signed: only an exact
 * Standard Webhooks signature can reach email rendering or side effects. Supabase
 * Auth only triggers it - the application owns rendering, transport and the delivery
 * ledger behind the ports in `server/domains/auth/ports.ts`. Rotating the hook
 * secret and exercising staging/production evidence remain separate human-owned
 * control-plane actions.
 */
import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";
import { createServiceRoleClient, readSupabaseAdminServiceEnv } from "../server/_lib/admin-domain/auth.js";
import { createSupabaseAuthEmailPersistencePort } from "../server/adapters/supabase/authEmailPersistencePort.js";
import { createAuthSendEmailHookCandidate } from "../server/domains/auth/authSendEmailHook.js";
import { createEmailTransport, emailTransportMessageId, resolveEmailApiKey } from "../server/infra/email/emailTransport.js";
import { createAuthEmailContentPort } from "#auth-email-content";
import {
  APP_FROM_EMAIL,
  APP_PRODUCTION_EMAIL_HOSTS,
  APP_SITE_ORIGIN,
  appEmailBrandForOrigin,
} from "../src/lib/brand/appBrand.js";

const env = process.env;
const emailTransport = createEmailTransport({ apiKey: resolveEmailApiKey(env), env });
const persistence = createSupabaseAuthEmailPersistencePort({
  createClient: () => {
    const supabase = readSupabaseAdminServiceEnv();
    if (!supabase) throw new Error("supabase_service_role_env_missing");
    return createServiceRoleClient(supabase) as never;
  },
});

const handler = createAuthSendEmailHookCandidate({
  persistence,
  content: createAuthEmailContentPort(),
  transport: {
    providerKind: emailTransport.providerKind,
    async send(message) {
      const result = await emailTransport.send({
        from: message.sender,
        to: message.recipient,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      return {
        outcome: {
          ...result.outcome,
          messageId: emailTransportMessageId(result.outcome),
        },
        providerResponse: result.providerResponse,
      };
    },
  },
  fromEmail: env.FROM_EMAIL ?? APP_FROM_EMAIL,
  hookSecret: env.SEND_EMAIL_HOOK_SECRET ?? "",
  authServiceUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "",
  defaultOrigin: APP_SITE_ORIGIN,
  productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS,
  legacyBaseUrl: env.openlup_BASE_URL,
  emailBrandForOrigin: appEmailBrandForOrigin,
  defaultSandboxRecipient: "delivered@resend.dev",
  defaultRedirectTo: env.AUTH_DEFAULT_REDIRECT_TO ?? "",
  env,
});

export default async function authSendEmail(req: VercelRequest, res: VercelResponse): Promise<void> {
  await handler(req, res);
}

export const config = { api: { bodyParser: false } };
