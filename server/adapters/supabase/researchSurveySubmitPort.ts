import type {
  MarketingResearchSurveyRequestHeaders,
  MarketingResearchSurveySubmitPort,
} from "../../../src/domains/marketing/research/ports.js";
import type {
  ResearchSurveySubmitRequest,
  ResearchSurveySubmitResponse,
} from "../../../src/domains/marketing/research/contracts.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  createManagedSurveyResponseSubmit,
  type ManagedSurveyResponseGateway,
} from "../../domains/marketing/research/managedSurveyResponseSubmit.js";
import {
  createPublicIntakeEmailDeliveryPort,
  type PublicIntakeEmailDeliveryClient,
} from "../email/publicIntakeEmailDeliveryPort.js";
import { createEmailTransport } from "../../infra/email/emailTransport.js";

type SurveySubmitRuntimeEnv = Record<string, string | undefined> & {
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RESEND_PROVIDER_MODE?: string;
  RESEND_API_KEY?: string;
  RESEND_SANDBOX_API_KEY?: string;
  FROM_EMAIL?: string;
  SURVEY_RESPONSE_NOTIFY_TO?: string;
  SURVEY_RESPONSE_RATE_LIMIT_WINDOW_MINUTES?: string;
  SURVEY_RESPONSE_RATE_LIMIT_MAX_PER_IP?: string;
};

type SurveyTable = "survey_responses_producer" | "survey_responses_consumer";
type SurveyTableClient = {
  select(columns: "id", options: { count: "exact"; head: true }): {
    eq(field: "ip_address", value: string): {
      gte(field: "created_at", value: string): Promise<{ count: number | null; error?: unknown }>;
    };
  };
  insert(row: Record<string, unknown>): {
    select(columns: "id"): {
      single(): Promise<{ data: { id: string } | null; error?: unknown }>;
    };
  };
  update(row: Record<string, unknown>): {
    eq(field: "id", value: string): Promise<unknown>;
  };
};
type SurveyClient = PublicIntakeEmailDeliveryClient & {
  from(table: SurveyTable): SurveyTableClient;
};

export function createSupabaseResearchSurveySubmitPort(
  env: SurveySubmitRuntimeEnv = process.env,
): MarketingResearchSurveySubmitPort {
  return {
    async submitSurveyResponse(request, context) {
      const config = resolveRuntimeConfig(env);
      if (config.ok === false) throw new Error(config.error);
      return runResearchSurveySubmitHandler(request, context?.headers, env, config);
    },
  };
}

export async function runResearchSurveySubmitHandler(
  request: ResearchSurveySubmitRequest,
  headers: MarketingResearchSurveyRequestHeaders | undefined,
  env: SurveySubmitRuntimeEnv = process.env,
  resolvedConfig?: Extract<ReturnType<typeof resolveRuntimeConfig>, { ok: true }>,
): Promise<ResearchSurveySubmitResponse> {
  const config = resolvedConfig ?? resolveRuntimeConfig(env);
  if (config.ok === false) throw new Error(config.error);
  const client = createServiceRoleClient({
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
  }) as unknown as SurveyClient;
  const gateway: ManagedSurveyResponseGateway = {
    async checkRateLimit(input) {
      const boundedWindow = Math.max(1, Math.min(input.windowMinutes, 720));
      const boundedMax = Math.max(1, Math.min(input.maxPerIp, 100));
      const since = new Date(input.now.getTime() - boundedWindow * 60_000).toISOString();
      try {
        const { count, error } = await client.from(input.table)
          .select("id", { count: "exact", head: true })
          .eq("ip_address", input.ip)
          .gte("created_at", since);
        if (error || count === null) return "unavailable";
        return count >= boundedMax ? "limited" : "allowed";
      } catch {
        return "unavailable";
      }
    },
    async insert(input) {
      const { data, error } = await client.from(input.table).insert({
        response_data: input.responseData,
        ip_address: input.ip,
        user_agent: input.userAgent,
      }).select("id").single();
      return error || !data ? null : { id: data.id };
    },
    async updateEmailStatus(input) {
      await client.from(input.table).update({
        email_sent_at: input.sentAt,
        email_error: input.error,
      }).eq("id", input.id);
    },
  };
  const submit = createManagedSurveyResponseSubmit({
    gateway,
    delivery: createPublicIntakeEmailDeliveryPort({
      client,
      transport: createEmailTransport({ apiKey: config.resendApiKey, env }),
    }),
    notifyTo: readNotifyTo(env),
    fromEmail: env.FROM_EMAIL || "openlup <hello@openlup.com>",
    windowMinutes: readPositiveNumberEnv(env, "SURVEY_RESPONSE_RATE_LIMIT_WINDOW_MINUTES", 60),
    maxPerIp: readPositiveNumberEnv(env, "SURVEY_RESPONSE_RATE_LIMIT_MAX_PER_IP", 20),
  });
  return submit(request, requestHeaders(headers));
}

function resolveRuntimeConfig(env: SurveySubmitRuntimeEnv):
  | { ok: true; url: string; serviceRoleKey: string; resendApiKey: string }
  | { ok: false; error: string } {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { ok: false, error: "supabase_service_role_not_configured" };
  }
  try {
    return { ok: true, url, serviceRoleKey, resendApiKey: readRequiredResendApiKey(env) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readRequiredResendApiKey(env: SurveySubmitRuntimeEnv): string {
  const providerMode = (env.RESEND_PROVIDER_MODE ?? "").trim().toLowerCase();
  if (providerMode === "sandbox") {
    const sandboxKey = env.RESEND_SANDBOX_API_KEY;
    if (!sandboxKey) throw new Error("RESEND_PROVIDER_MODE=sandbox requires RESEND_SANDBOX_API_KEY");
    return sandboxKey;
  }
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required unless RESEND_PROVIDER_MODE=sandbox is set");
  }
  return env.RESEND_API_KEY;
}

function requestHeaders(input: MarketingResearchSurveyRequestHeaders | undefined): Headers {
  const headers = new Headers();
  input?.forEach((value, key) => headers.set(key, value));
  return headers;
}

export function readNotifyTo(env: SurveySubmitRuntimeEnv): string[] {
  return (env.SURVEY_RESPONSE_NOTIFY_TO ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function readPositiveNumberEnv(env: SurveySubmitRuntimeEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
