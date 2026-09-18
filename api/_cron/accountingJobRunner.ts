import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { evaluateDeploymentRoutePolicy } from "#deployment-route-policy";
import {
  runAccountingRuntimeOnce,
  type AccountingGatewayFactory,
  type AccountingJobKind,
  type AccountingRuntimeEnv,
} from "../../server/runtime/accounting/accountingRuntime.js";
import { readAccountingProviderMode } from "../../server/infra/accounting/providerFactory.js";

export type AccountingCronKind = AccountingJobKind;
type Env = AccountingRuntimeEnv & { CRON_SECRET?: string };

/** HTTP transport adapter only. Accounting execution lives in the portable runtime. */
export async function runAccountingCron(
  req: VercelRequest,
  kind: AccountingCronKind,
  env: Env = process.env,
  gatewayFactory?: AccountingGatewayFactory,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const methodAllowed = kind === "ksef-status"
    ? req.method === "GET"
    : req.method === "GET" || req.method === "POST";
  if (!methodAllowed) return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  if (!env.CRON_SECRET) return { status: 500, body: { ok: false, error: "cron_secret_not_configured" } };
  if (bearerToken(req) !== env.CRON_SECRET) return { status: 401, body: { ok: false, error: "unauthorized" } };

  // The preview provider guard is a HTTP surface policy, not an accounting
  // domain dependency. Workers use their deployment's own environment gate.
  if (readAccountingProviderMode(env) === "fakturownia") {
    const guard = evaluateDeploymentRoutePolicy({
      route: `/api/cron/${accountingCronPath(kind)}`,
      domain: "accounting",
      surface: "hidden",
      risk: "provider",
    }, req, env);
    if (!guard.allowed) {
      return {
        status: 503,
        body: { ok: false, checked: 0, updated: 0, skipped: true, failures: 1, reason: `hidden_preview_guard_${guard.reason}` },
      };
    }
  }

  return runAccountingRuntimeOnce({
    kind,
    env,
    gatewayFactory,
    context: {
      triggerKind: "scheduler",
      invocationSource: "authenticated_http_scheduler",
      orderId: queryParam(req, "order_id"),
    },
  });
}

function accountingCronPath(kind: AccountingCronKind): string {
  if (kind === "invoice-issue") return "accounting-invoices";
  if (kind === "invoice-delivery") return "accounting-invoice-delivery";
  if (kind === "invoice-correction") return "accounting-invoice-corrections";
  return "accounting-ksef-status";
}

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function queryParam(req: VercelRequest, name: string): string | null {
  const value = req.query[name];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : null;
}
