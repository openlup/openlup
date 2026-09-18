import type { VercelRequest } from "../_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../adapters/supabase/dataGatewayClientFactory.js";
import { createSupabaseAlertLedgerPort } from "../adapters/supabase/platform/alertLedgerPort.js";
import { createSupabaseObservabilityEvidencePort } from "../adapters/supabase/platform/observabilityEvidencePort.js";
import { readOpenDeliveryAlignmentCases } from "../adapters/subscriptionDeliveryAlignmentGateway.js";
import { withOrderMoneyReconciliationEvidence } from "../adapters/supabase/platform/orderMoneyReconciliationEvidence.js";
import { withPromotionObservabilityEvidence } from "../adapters/supabase/platform/promotionObservabilityEvidence.js";
import { withShipmentTrackingRefEvidence } from "../adapters/supabase/platform/shipmentTrackingRefEvidenceAdapter.js";
import { runPlatformWatchdog } from "../domains/platform/platformWatchdogService.js";
import { parsePagingMinSeverity } from "../../src/domains/platform/alertPagingPolicy.js";
import { createPlatformAlertSink } from "../adapters/platform/platformAlertSink.js";
import { JOB_CATALOG } from "../../src/domains/platform/jobCatalog.js";
import { recordWatchdogHeartbeat } from "../adapters/supabase/platform/watchdogHeartbeat.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { readAccountingRuntimeConfig } from "../domains/accounting/accountingRuntimeConfig.js";
import {
  createStagingSyntheticMoneyDecisionNormalizer,
  promotionWatchdogReady,
} from "./promotionWatchdogReadiness.js";
import { resolveBundleId } from "../domains/platform-runtime/platformKernel.js";
import { runDirectPlatformWatchdogTick } from "../runtime/platform/controlPlaneBinding.js";

type Env = {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  CHANNEL_ORDER_PULL_ENABLED?: string;
  COMMERCE_ABANDONED_CART_ENABLED?: string;
  COMMERCE_CHECKOUT_RECOVERY_ENABLED?: string;
  COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED?: string;
  COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED?: string;
  ACCOUNTING_ISSUE_TRIGGER?: string;
  COMMERCE_ACCOUNTING_ISSUE_TRIGGER?: string;
  COMMERCE_DHL_ONLY_DELIVERY?: string;
  COMMERCE_DUNNING_EMAILS_ENABLED?: string;
  COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED?: string;
  COMMERCE_OUTBOX_DISPATCH_ENABLED?: string;
  COMMERCE_OUTBOX_PRUNE_ENABLED?: string;
  COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED?: string;
  COMMERCE_PSP_OBSERVABILITY_ENABLED?: string;
  COMMERCE_PROMOTION_CODES_OBSERVABILITY_ENABLED?: string;
  COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED?: string;
  COMMERCE_REORDER_REMINDER_ENABLED?: string;
  COMMERCE_REVIEW_REQUEST_ENABLED?: string;
  COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED?: string;
  COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED?: string;
  COMMERCE_RESERVATION_SWEEP_ENABLED?: string;
  COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED?: string;
  COMMERCE_SUBSCRIPTION_SWEEP_ENABLED?: string;
  COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED?: string;
  COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED?: string;
  COMMERCE_SUBSCRIPTION_WINBACK_ENABLED?: string;
  COMMUNICATION_SYNC_DISPATCH_ENABLED?: string;
  COMMUNICATION_SYNC_RECONCILE_ENABLED?: string;
  SUBSCRIPTION_RENEWAL_REMINDER_ENABLED?: string;
  PLATFORM_ALERT_WEBHOOK_URL?: string;
  PLATFORM_ALERT_WEBHOOK_SECRET?: string;
  PLATFORM_ALERT_PAGING_MIN_SEVERITY?: string;
  PLATFORM_ALERT_WEBHOOK_FORMAT?: string;
  PLATFORM_WATCHDOG_SUPPRESSED_DEDUPE_PREFIXES?: string;
  PLATFORM_BUNDLE?: string;
  PLATFORM_OPERATOR_ID?: string;
  DATABASE_URL?: string;
  openlup_ENVIRONMENT?: string;
  VERCEL_ENV?: string;
};

function parseDedupePrefixes(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function platformAlertEnvironment(env: Pick<Env, "openlup_ENVIRONMENT" | "VERCEL_ENV">): string {
  return env.openlup_ENVIRONMENT?.trim() || env.VERCEL_ENV?.trim() || "unknown";
}

const PLATFORM_EMAIL_PRODUCTION_HOSTS = ["openlup.com", "www.openlup.com"] as const;
export type PlatformWatchdogHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;
type WatchdogRunner = typeof runPlatformWatchdog;
type DirectWatchdogRunner = typeof runDirectPlatformWatchdogTick;

function executeWatchdog(input: Parameters<WatchdogRunner>[0], override?: WatchdogRunner) {
  return override ? override(input) : runPlatformWatchdog(input);
}

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function boolValue(value: unknown): boolean {
  if (Array.isArray(value)) return boolValue(value[0]);
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function bodyRecord(req: VercelRequest): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

export async function runPlatformWatchdogRoute(
  req: VercelRequest,
  env: Env = process.env,
  now = new Date(),
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
  fetchImpl: typeof fetch = fetch,
  watchdogRunner?: WatchdogRunner,
  directWatchdogRunner: DirectWatchdogRunner = runDirectPlatformWatchdogTick,
): Promise<PlatformWatchdogHttpResult> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }

  if (!env.CRON_SECRET) {
    return {
      status: 500,
      body: {
        ok: false,
        health: "configuration_failure",
        firingCount: 0,
        error: "cron_secret_not_configured",
      },
    };
  }
  if (bearerToken(req) !== env.CRON_SECRET) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  const body = bodyRecord(req);
  const checkOnly = boolValue(req.query.checkOnly) || boolValue(body.checkOnly);
  const webhookConfigured = Boolean(env.PLATFORM_ALERT_WEBHOOK_URL?.trim());

  if (resolveBundleId(env) === "node-postgres") {
    return directWatchdogRunner(env, now, checkOnly);
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) return { status: 500, body: {
    ok: false, health: "configuration_failure", firingCount: 0,
    error: "supabase_service_role_not_configured",
  } };

  try {
    const accountingRuntime = readAccountingRuntimeConfig(env);
    const pagingMinSeverity = parsePagingMinSeverity(env.PLATFORM_ALERT_PAGING_MIN_SEVERITY);
    const environment = platformAlertEnvironment(env);
    let heartbeatRecorded = false;
    const result = await gatewayFactory(gatewayEnv).asService(async (client) => {
      const watchdogResult = await executeWatchdog({
        evidencePort: withShipmentTrackingRefEvidence(
          withPromotionObservabilityEvidence(
          withOrderMoneyReconciliationEvidence(
            createSupabaseObservabilityEvidencePort(
            client as never,
            {
              CHANNEL_ORDER_PULL_ENABLED: env.CHANNEL_ORDER_PULL_ENABLED === "true",
              COMMERCE_ABANDONED_CART_ENABLED: env.COMMERCE_ABANDONED_CART_ENABLED === "true",
              COMMERCE_CHECKOUT_RECOVERY_ENABLED: env.COMMERCE_CHECKOUT_RECOVERY_ENABLED === "true",
              COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED: env.COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED === "true",
              COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED: env.COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED === "true",
              // The standalone direct-DHL rail is retired. Ignore hostile legacy
              // env values so watchdog evaluation cannot resurrect its job SLA.
              COMMERCE_DHL_ONLY_DELIVERY: false,
              COMMERCE_DUNNING_EMAILS_ENABLED: env.COMMERCE_DUNNING_EMAILS_ENABLED === "true",
              COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: env.COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED === "true",
              COMMERCE_OUTBOX_DISPATCH_ENABLED: env.COMMERCE_OUTBOX_DISPATCH_ENABLED === "true",
              COMMERCE_OUTBOX_PRUNE_ENABLED: env.COMMERCE_OUTBOX_PRUNE_ENABLED === "true",
              COMMERCE_PSP_OBSERVABILITY_ENABLED: env.COMMERCE_PSP_OBSERVABILITY_ENABLED === "true",
              COMMERCE_REORDER_REMINDER_ENABLED: env.COMMERCE_REORDER_REMINDER_ENABLED === "true",
              COMMERCE_REVIEW_REQUEST_ENABLED: env.COMMERCE_REVIEW_REQUEST_ENABLED === "true",
              COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED: env.COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED === "true",
              COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED: env.COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED === "true",
              COMMERCE_RESERVATION_SWEEP_ENABLED: env.COMMERCE_RESERVATION_SWEEP_ENABLED === "true",
              COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED: env.COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED === "true",
              COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED: env.COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED === "true",
              COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: env.COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED === "true",
              COMMERCE_SUBSCRIPTION_SWEEP_ENABLED: env.COMMERCE_SUBSCRIPTION_SWEEP_ENABLED === "true",
              COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED: env.COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED === "true",
              COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED: env.COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED === "true",
              COMMERCE_SUBSCRIPTION_WINBACK_ENABLED: env.COMMERCE_SUBSCRIPTION_WINBACK_ENABLED === "true",
              COMMUNICATION_SYNC_DISPATCH_ENABLED: env.COMMUNICATION_SYNC_DISPATCH_ENABLED === "true",
              COMMUNICATION_SYNC_RECONCILE_ENABLED: env.COMMUNICATION_SYNC_RECONCILE_ENABLED === "true",
              SUBSCRIPTION_RENEWAL_REMINDER_ENABLED: env.SUBSCRIPTION_RENEWAL_REMINDER_ENABLED === "true",
            },
            { emailProductionHosts: PLATFORM_EMAIL_PRODUCTION_HOSTS, readOpenDeliveryAlignmentCases: () => readOpenDeliveryAlignmentCases(client) },
            ),
            client as never,
            { issueTrigger: accountingRuntime.issueTrigger },
          ),
          client as never,
          {
            healthEnabled: env.COMMERCE_PROMOTION_CODES_OBSERVABILITY_ENABLED === "true",
          },
        ),
          client as never,
        ),
        ledgerPort: createSupabaseAlertLedgerPort(client as never),
        sinkPort: createPlatformAlertSink({
          fetchImpl,
          webhookUrl: env.PLATFORM_ALERT_WEBHOOK_URL,
          webhookSecret: env.PLATFORM_ALERT_WEBHOOK_SECRET,
          wireFormat: env.PLATFORM_ALERT_WEBHOOK_FORMAT,
          environment: platformAlertEnvironment(env),
        }),
        catalog: JOB_CATALOG,
        now,
        checkOnly,
        pagingMinSeverity,
        mutedDedupePrefixes: parseDedupePrefixes(env.PLATFORM_WATCHDOG_SUPPRESSED_DEDUPE_PREFIXES),
        normalizeDecision: createStagingSyntheticMoneyDecisionNormalizer(environment),
      }, watchdogRunner);
      // A dry run must not forge liveness: only a persisting tick stamps the heartbeat.
      if (!checkOnly) {
        const promotionReady = promotionWatchdogReady({
          environment,
          healthEnabled: env.COMMERCE_PROMOTION_CODES_OBSERVABILITY_ENABLED === "true",
          claimSweepEnabled: env.COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED === "true",
          decisions: watchdogResult.decisions,
        });
        heartbeatRecorded = await recordWatchdogHeartbeat(client as never, {
          health: watchdogResult.health,
          firingCount: watchdogResult.firingCount,
          maxSeverity: watchdogResult.maxSeverity ?? null,
          promotionReady,
        }, now);
      }
      return watchdogResult;
    });
    const responseBody = {
      ...(result as unknown as Record<string, unknown>),
      environment,
      promotionRuntime: {
        healthEnabled: env.COMMERCE_PROMOTION_CODES_OBSERVABILITY_ENABLED === "true",
        claimSweepEnabled: env.COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED === "true",
      },
      webhookConfigured,
      heartbeatRecorded,
    };
    // Acknowledgement stops repeat pages but not operator ownership, while an
    // active snooze intentionally suppresses current actionability. The service
    // computes this from durable alert state so this binding never reinterprets
    // raw decisions as a configuration failure.
    const requiresConfiguredSink = !checkOnly && result.actionablePageableCount > 0;

    if (requiresConfiguredSink && !webhookConfigured) {
      return {
        status: 503,
        body: {
          ...responseBody,
          ok: false,
          health: "configuration_failure",
          error: "platform_alert_webhook_url_not_configured",
        },
      };
    }
    if (result.notificationFailures > 0) {
      return {
        status: 502,
        body: {
          ...responseBody,
          ok: false,
          health: "transport_failure",
          error: "platform_alert_notification_failed",
        },
      };
    }

    return { status: 200, body: responseBody };
  } catch (error) {
    return {
      status: 502,
      body: {
        ok: false,
        health: "evaluation_failure",
        firingCount: 0,
        error: "platform_watchdog_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
