import type {
  PartnersB2BInquirySubmitPort,
  PartnersB2BInquiryRequestHeaders,
} from "../../../src/domains/partners/ports.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  createPublicIntakeEmailDeliveryPort,
  type PublicIntakeEmailDeliveryClient,
} from "../email/publicIntakeEmailDeliveryPort.js";
import { createManagedB2BInquirySubmit } from "../../domains/partners/managedB2BInquirySubmit.js";
import { createPrivateLabelB2BInquiryPresenter } from "../email/privateLabelB2BInquiryPresenter.js";
import { createEmailTransport } from "../../infra/email/emailTransport.js";

type PartnersB2BInquiryRuntimeEnv = Record<string, string | undefined> & {
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RESEND_PROVIDER_MODE?: string;
  RESEND_API_KEY?: string;
  RESEND_SANDBOX_API_KEY?: string;
  FROM_EMAIL?: string;
  B2B_NOTIFICATION_EMAIL?: string;
  APP_BASE_URL?: string;
  openlup_BASE_URL?: string;
  CUSTOMER_AUTH_REDIRECT_ORIGIN?: string;
  SITE_URL?: string;
  HIDDEN_SANDBOX_PREVIEW_ENABLED?: string;
  EMAIL_ENVIRONMENT?: string;
  EMAIL_DEFAULT_ORIGIN?: string;
  EMAIL_PRODUCTION_ORIGIN_HOSTS?: string;
};

type EdgeB2BInquiryBody = { success?: boolean; id?: string; skipped?: unknown; error?: string; code?: string };
type SubmitB2bInquiryRpcRow = { allowed: boolean; inquiry_id: string | null };
type B2bClient = PublicIntakeEmailDeliveryClient & {
  rpc?(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error?: unknown }>;
};

export type PartnersB2BInquiryRunner = (
  request: {
    company: string;
    country: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    notes?: string | null;
    openlupInternalCheck?: string;
  },
  context?: { headers?: PartnersB2BInquiryRequestHeaders },
  env?: PartnersB2BInquiryRuntimeEnv,
) => Promise<{ status: number; body: EdgeB2BInquiryBody }>;

export function createSupabasePartnersB2BInquirySubmitPort(options: {
  env?: PartnersB2BInquiryRuntimeEnv;
  runB2BInquirySubmit?: PartnersB2BInquiryRunner;
} = {}): PartnersB2BInquirySubmitPort {
  const runB2BInquirySubmit = options.runB2BInquirySubmit ?? runB2BInquirySubmitHandler;
  return {
    async submitB2BInquiry(request, context) {
      const result = await runB2BInquirySubmit(request, context, options.env);
      if (typeof result.body.success !== "boolean") throw new Error("B2B inquiry submit returned incomplete data");
      return {
        success: result.body.success,
        id: result.body.id,
        skipped: typeof result.body.skipped === "string" ? result.body.skipped : undefined,
        error: result.body.error,
        code: result.body.code,
        status: result.status,
      };
    },
  };
}

export const runB2BInquirySubmitHandler: PartnersB2BInquiryRunner = async (request, context, env = process.env) => {
  const config = resolveRuntimeConfig(env);
  if (config.ok === false) return { status: 500, body: { success: false, error: config.error, code: config.error } };
  const client = createServiceRoleClient({ url: config.url, serviceRoleKey: config.serviceRoleKey }) as unknown as B2bClient;
  const submit = createManagedB2BInquirySubmit({
    gateway: {
      async submit(input) {
        if (!client.rpc) return { kind: "unavailable" };
        try {
          const { data, error } = await client.rpc("public_submit_b2b_inquiry", {
            p_ip_hash: input.ipHash,
            p_company: input.request.company.trim(),
            p_country: input.request.country,
            p_first_name: input.request.firstName.trim(),
            p_last_name: input.request.lastName.trim(),
            p_business_email: input.request.email.trim().toLowerCase(),
            p_phone: input.request.phone?.trim() || null,
            p_notes: input.request.notes?.trim() || null,
            p_window_minutes: 60,
            p_max_per_ip: 3,
          });
          const row = parseSubmitRpcRow(data);
          if (error || !row) return { kind: "unavailable" };
          return row.allowed ? { kind: "accepted", id: row.inquiry_id! } : { kind: "rate_limited" };
        } catch {
          return { kind: "unavailable" };
        }
      },
    },
    delivery: createPublicIntakeEmailDeliveryPort({
      client,
      transport: createEmailTransport({ apiKey: config.resendApiKey, env }),
    }),
    notificationTo: readNotificationTo(env),
    presenter: createPrivateLabelB2BInquiryPresenter(env),
    hiddenPreviewEnabled: env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true",
  });
  const result = await submit(request, requestHeaders(context?.headers), Boolean(request.openlupInternalCheck));
  return { status: result.status, body: result };
};

function resolveRuntimeConfig(env: PartnersB2BInquiryRuntimeEnv):
  | { ok: true; url: string; serviceRoleKey: string; resendApiKey: string }
  | { ok: false; error: string } {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return { ok: false, error: "supabase_service_role_not_configured" };
  try {
    return { ok: true, url, serviceRoleKey, resendApiKey: readRequiredResendApiKey(env) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readRequiredResendApiKey(env: PartnersB2BInquiryRuntimeEnv): string {
  if ((env.RESEND_PROVIDER_MODE ?? "").trim().toLowerCase() === "sandbox") {
    if (!env.RESEND_SANDBOX_API_KEY) throw new Error("RESEND_PROVIDER_MODE=sandbox requires RESEND_SANDBOX_API_KEY");
    return env.RESEND_SANDBOX_API_KEY;
  }
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required unless RESEND_PROVIDER_MODE=sandbox is set");
  return env.RESEND_API_KEY;
}

export function readNotificationTo(env: PartnersB2BInquiryRuntimeEnv): string[] {
  return (env.B2B_NOTIFICATION_EMAIL ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}


function requestHeaders(input: PartnersB2BInquiryRequestHeaders | undefined): Headers {
  const headers = new Headers();
  if (input instanceof Headers) input.forEach((value, key) => headers.set(key, value));
  else for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

function parseSubmitRpcRow(data: unknown): SubmitB2bInquiryRpcRow | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const candidate = row as Partial<SubmitB2bInquiryRpcRow>;
  if (typeof candidate.allowed !== "boolean") return null;
  if (candidate.allowed && (typeof candidate.inquiry_id !== "string" || !candidate.inquiry_id)) return null;
  return { allowed: candidate.allowed, inquiry_id: typeof candidate.inquiry_id === "string" ? candidate.inquiry_id : null };
}
