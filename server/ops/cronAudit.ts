import type { VercelRequest } from "../_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../adapters/supabase/dataGatewayClientFactory.js";
import { buildCronAudit } from "./cronAuditReport.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import type { AuditResult, Env, SupabaseClientLike } from "./cronAuditTypes.js";

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function numberParam(req: VercelRequest, key: string, fallback: number, max: number): number {
  const raw = req.query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export async function runCronAudit(
  req: VercelRequest,
  env: Env = process.env,
  now = new Date(),
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
): Promise<AuditResult> {
  if (req.method !== "GET") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }

  const cronSecret = env.CRON_SECRET;
  if (!cronSecret) {
    return { status: 500, body: { ok: false, error: "cron_secret_not_configured" } };
  }

  if (bearerToken(req) !== cronSecret) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 500, body: { ok: false, error: "supabase_service_role_not_configured" } };
  }

  const lookbackHours = numberParam(req, "lookbackHours", 96, 336);
  const audit = await gatewayFactory(gatewayEnv).asService((client) =>
    buildCronAudit(client as SupabaseClientLike, lookbackHours, now),
  );

  return { status: audit.ok ? 200 : 207, body: audit };
}
