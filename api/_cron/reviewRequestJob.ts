// Daily review-request enqueue cron. Calls enqueue_review_requests(p_limit),
// which mints review tokens + enqueues commerce.order.review_request outbox
// events for orders delivered > N days ago without feedback. The outbox
// dispatcher (with COMMERCE_REVIEW_REQUEST_ENABLED on) then renders + sends the
// consent-gated marketing email. This job only scans + enqueues — no provider
// or email IO here, so it has no Resend readiness gate.

import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { createSupabaseReviewRequestEnqueuePort } from "../../server/adapters/supabase/commerce/reviewRequestEnqueue.js";
import { resolveBundleId } from "../../server/domains/platform-runtime/platformKernel.js";
import { resolveSubscriberRetentionMessagingBinding } from "../../server/runtime/subscription/subscriberRetentionMessagingBinding.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  COMMERCE_REVIEW_REQUEST_ENABLED?: string;
  DATABASE_URL?: string;
  PLATFORM_BUNDLE?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export const REVIEW_REQUEST_JOB_NAME = "review-request";

const JOB_LEASE_SECONDS = 120;
const ENQUEUE_LIMIT = 200;

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

export async function runReviewRequestCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
  retentionBindingResolver: typeof resolveSubscriberRetentionMessagingBinding = resolveSubscriberRetentionMessagingBinding,
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

  // Env kill-switch exits before any client/ledger work so a long-duration
  // disable stays silent (zero platform_job_runs writes).
  if (env.COMMERCE_REVIEW_REQUEST_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "review_request_disabled", enqueued: 0 },
    };
  }

  if (resolveBundleId(env) === "node-postgres") {
    const resolved = retentionBindingResolver(env);
    if (!resolved.binding) return { status: 503, body: { ok: false, error: resolved.error } };
    const result = await resolved.binding.run((messaging) => messaging.planAndDispatch("review_request", ENQUEUE_LIMIT));
    return { status: result.ok ? 200 : 502, body: { ...result, kind: "review_request" } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_required" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(client as never, REVIEW_REQUEST_JOB_NAME, "vercel_cron", JOB_LEASE_SECONDS);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    const enqueuePort = createSupabaseReviewRequestEnqueuePort(client as never);

    // Scan both review touchpoints in one run (same flag/job): the +N-day
    // first-impression request and the 14-60 day effects review. Each scan is
    // independent; a failure in one is surfaced without masking the other's count.
    let enqueuedRequests = 0;
    let enqueuedEffects = 0;
    let ok = true;
    let reason: string | undefined;
    try {
      enqueuedRequests = await enqueuePort.enqueueRequests(ENQUEUE_LIMIT);
    } catch (error) {
      ok = false;
      reason = safeMessage(error);
    }
    try {
      enqueuedEffects = await enqueuePort.enqueueEffects(ENQUEUE_LIMIT);
    } catch (error) {
      ok = false;
      reason = reason ?? safeMessage(error);
    }

    const enqueued = enqueuedRequests + enqueuedEffects;

    try {
      await finishJobRun(
        client as never,
        REVIEW_REQUEST_JOB_NAME,
        lease.runId,
        ok ? "success" : "failed",
        { checked: enqueued, updated: enqueued, failures: ok ? 0 : 1, skipped: false, reason },
        { driver: "vercel_cron", enqueuedRequests, enqueuedEffects },
      );
    } catch (error) {
      console.error("[review-request] finish_job_run_failed", safeMessage(error));
    }

    return { status: ok ? 200 : 502, body: { ok, enqueued, enqueuedRequests, enqueuedEffects, reason } };
  });
}
