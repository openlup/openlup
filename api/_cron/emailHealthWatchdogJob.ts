import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { readEmailHealthMetrics } from "../../server/adapters/supabase/adminEmailSendsDeliveryEvidence.js";
import { readMandatoryNotificationControlReadiness } from "../../server/adapters/supabase/notificationControlsPort.js";
import type { EmailHealthMetrics } from "../../server/domains/communications/emailHealthMetricsPort.js";
import type { MandatoryNotificationControlReadiness } from "../../server/domains/communications/emailNotificationControlReadiness.js";
import { activeCustomerEmailFlowFlags } from "../../server/domains/communications/customerEmailFlowReadiness.js";
import { readAccountingRuntimeConfig } from "../../server/domains/accounting/accountingRuntimeConfig.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import {
  readOutboxHandlerGroupReadiness,
  type OutboxHandlerGroup,
} from "./outboxHandlerGroupReadiness.js";

/** Query-only, provider-neutral delivery monitor; returns 503 for health and readiness breaches. */

type Env = Record<string, string | undefined>;
type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

// Assessment layer (thresholds + verdict) lives in
// server/domains/communications/emailHealthAssessment.ts; re-exported here so
// existing importers keep their entry point.
export {
  evaluateEmailHealth,
  readEmailHealthThresholds,
  type EmailHealthAssessment,
  type EmailHealthBreach,
  type EmailHealthThresholds,
} from "../../server/domains/communications/emailHealthAssessment.js";
import {
  evaluateEmailHealth,
  readEmailHealthThresholds,
  type EmailHealthBreach,
} from "../../server/domains/communications/emailHealthAssessment.js";

export type { EmailHealthMetrics };

type EmailHandlerGroup = Exclude<OutboxHandlerGroup, "fulfillment">;

/**
 * Operator-safe projection of the existing outbox handler readiness. It tells
 * operators whether the email runtime is configured and whether every
 * currently requested email group can be dispatched, without returning env
 * values, URLs, provider modes, or customer data.
 */
export interface EmailRuntimeReadiness {
  configured: {
    provider: boolean;
    emailOrigin: boolean;
  };
  dispatch: {
    allRequestedGroupsReady: boolean;
    requestedGroupCount: number;
    readyGroupCount: number;
    requestedGroups: EmailHandlerGroup[];
    readyGroups: EmailHandlerGroup[];
    blockedGroups: EmailHandlerGroup[];
  };
  notificationControls?: {
    requiredControlCount: number;
    disabledControlCount: number;
    disabledControlKeys: string[];
  };
}

const CORE_EMAIL_HANDLER_GROUPS = ["transactional_email", "subscription_email"] as const;
const MARKETING_EMAIL_HANDLER_GROUP = "marketing_email" as const;

export function projectEmailRuntimeReadiness(env: Env): EmailRuntimeReadiness {
  const readiness = readOutboxHandlerGroupReadiness(env);
  const marketingRequested =
    readiness.readyGroups.includes(MARKETING_EMAIL_HANDLER_GROUP) ||
    MARKETING_EMAIL_HANDLER_GROUP in readiness.disabledHandlerGroups;
  const requestedGroups: EmailHandlerGroup[] = marketingRequested
    ? [...CORE_EMAIL_HANDLER_GROUPS, MARKETING_EMAIL_HANDLER_GROUP]
    : [...CORE_EMAIL_HANDLER_GROUPS];
  const readyGroups = requestedGroups.filter((group) => readiness.readyGroups.includes(group));
  const blockedGroups = requestedGroups.filter((group) => !readyGroups.includes(group));

  return {
    configured: {
      provider: Boolean(readiness.resend.apiKey),
      emailOrigin: readiness.emailBaseUrl !== null,
    },
    dispatch: {
      allRequestedGroupsReady: blockedGroups.length === 0,
      requestedGroupCount: requestedGroups.length,
      readyGroupCount: readyGroups.length,
      requestedGroups,
      readyGroups,
      blockedGroups,
    },
  };
}

function withNotificationControlReadiness(
  runtimeReadiness: EmailRuntimeReadiness,
  notificationControls: MandatoryNotificationControlReadiness,
): EmailRuntimeReadiness {
  return {
    ...runtimeReadiness,
    notificationControls: {
      requiredControlCount: notificationControls.requiredControlCount,
      disabledControlCount: notificationControls.disabledControlKeys.length,
      disabledControlKeys: notificationControls.disabledControlKeys,
    },
  };
}

export async function runEmailHealthWatchdogCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
  now: () => number = () => Date.now(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) {
    return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  }
  if (bearerToken(req) !== env.CRON_SECRET) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  const runtimeReadiness = projectEmailRuntimeReadiness(env);
  const activeCustomerEmailFlows = activeCustomerEmailFlowFlags(env, {
    accountingProviderEmailEnabled: readAccountingRuntimeConfig(env).providerEmailEnabled,
  });
  if (env.COMMERCE_EMAIL_HEALTH_WATCHDOG_ENABLED !== "true") {
    if (activeCustomerEmailFlows.length > 0) {
      console.error(
        "[email-health-watchdog] disabled_while_customer_email_active",
        JSON.stringify({ activeCustomerEmailFlows, runtimeReadiness }),
      );
      return {
        status: 503,
        body: {
          ok: false,
          error: "email_health_watchdog_disabled_while_customer_email_active",
          activeCustomerEmailFlows,
          runtimeReadiness,
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        skipped: true,
        reason: "email_health_watchdog_disabled",
        runtimeReadiness,
      },
    };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_required", runtimeReadiness } };
  }

  const thresholds = readEmailHealthThresholds(env);
  const nowMs = now();
  const window = {
    windowStartIso: new Date(nowMs - thresholds.windowMinutes * 60_000).toISOString(),
    stuckBeforeIso: new Date(nowMs - thresholds.stuckMinutes * 60_000).toISOString(),
  };

  let metrics: EmailHealthMetrics;
  let notificationControls: MandatoryNotificationControlReadiness;
  try {
    ({ metrics, notificationControls } = await gatewayFactory(gatewayEnv).asService(async (client) => {
      const [metricsResult, notificationControlsResult] = await Promise.all([
        readEmailHealthMetrics(client as Parameters<typeof readEmailHealthMetrics>[0], window),
        readMandatoryNotificationControlReadiness(client as Parameters<typeof readMandatoryNotificationControlReadiness>[0]),
      ]);
      return { metrics: metricsResult, notificationControls: notificationControlsResult };
    }));
  } catch (error) {
    console.error("[email-health-watchdog] health_readback_failed", safeMessage(error));
    return {
      status: 503,
      body: { ok: false, error: "email_health_readback_failed", runtimeReadiness },
    };
  }

  const runtimeReadinessWithControls = withNotificationControlReadiness(runtimeReadiness, notificationControls);
  const assessment = evaluateEmailHealth(metrics, thresholds);
  const readinessBreaches: EmailHealthBreach[] = runtimeReadinessWithControls.dispatch.allRequestedGroupsReady
    ? []
    : [{
      code: "runtime_readiness",
      detail: `email handler groups not dispatchable: ${runtimeReadinessWithControls.dispatch.blockedGroups.join(", ")}`,
    }];
  const notificationControlBreaches: EmailHealthBreach[] = notificationControls.disabledControlKeys.length === 0
    ? []
    : [{
      code: "notification_controls_disabled",
      detail: `mandatory customer notification controls are disabled: ${notificationControls.disabledControlKeys.join(", ")}`,
    }];
  const breaches = [...assessment.breaches, ...readinessBreaches, ...notificationControlBreaches];
  const healthy = breaches.length === 0;
  const body = {
    ok: healthy,
    windowMinutes: thresholds.windowMinutes,
    metrics,
    failureRatio: Number(assessment.failureRatio.toFixed(4)),
    breaches,
    runtimeReadiness: runtimeReadinessWithControls,
  };

  // Structured line for log-drain / Axiom alerting regardless of HTTP status.
  console[healthy ? "log" : "error"](
    "[email-health-watchdog]",
    JSON.stringify({ healthy, ...metrics, breaches, runtimeReadiness: runtimeReadinessWithControls }),
  );

  // 503 on breach so Vercel marks the cron failed and surfaces it to ops.
  return { status: healthy ? 200 : 503, body };
}

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
