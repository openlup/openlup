import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import type { SupabaseDataGatewayEnv } from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import {
  evaluateEmailHealth,
  projectEmailRuntimeReadiness,
  readEmailHealthThresholds,
  runEmailHealthWatchdogCron,
  type EmailHealthMetrics,
  type EmailHealthThresholds,
} from "./emailHealthWatchdogJob.ts";

const THRESHOLDS: EmailHealthThresholds = {
  windowMinutes: 60,
  stuckMinutes: 30,
  minAttemptsForRatio: 5,
  maxFailureRatio: 0.5,
  maxStuck: 0,
  maxPermanentFailures: 0,
};

const HEALTHY: EmailHealthMetrics = {
  attempted: 20,
  sent: 20,
  failed: 0,
  delayed: 0,
  permanentFailures: 0,
  stuckProcessing: 0,
  stuckScheduled: 0,
};

describe("evaluateEmailHealth", () => {
  it("is healthy when nothing is failing or stuck", () => {
    const result = evaluateEmailHealth(HEALTHY, THRESHOLDS);
    expect(result.healthy).toBe(true);
    expect(result.breaches).toEqual([]);
  });

  it("breaches on a high failure ratio once the sample is large enough", () => {
    const result = evaluateEmailHealth({ ...HEALTHY, attempted: 10, sent: 3, failed: 7 }, THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.breaches.map((b) => b.code)).toContain("failure_ratio");
  });

  it("does NOT breach on a tiny sample even if the ratio is high", () => {
    // 2/3 failures but below minAttemptsForRatio — avoids alert noise on low volume.
    const result = evaluateEmailHealth({ ...HEALTHY, attempted: 3, sent: 1, failed: 2 }, THRESHOLDS);
    expect(result.healthy).toBe(true);
  });

  it("breaches when emails are stuck in processing", () => {
    const result = evaluateEmailHealth({ ...HEALTHY, stuckProcessing: 4 }, THRESHOLDS);
    expect(result.breaches.map((b) => b.code)).toContain("stuck_processing");
  });

  it("breaches when scheduled emails are overdue and undispatched", () => {
    const result = evaluateEmailHealth({ ...HEALTHY, stuckScheduled: 9 }, THRESHOLDS);
    expect(result.breaches.map((b) => b.code)).toContain("stuck_scheduled");
  });
});

describe("readEmailHealthThresholds", () => {
  it("uses safe defaults when env is empty", () => {
    expect(readEmailHealthThresholds({})).toEqual(THRESHOLDS);
  });

  it("honours overrides and rejects nonsense", () => {
    const t = readEmailHealthThresholds({
      EMAIL_HEALTH_WINDOW_MINUTES: "120",
      EMAIL_HEALTH_MAX_FAILURE_RATIO: "0.2",
      EMAIL_HEALTH_MAX_FAILURE_RATIO_BOGUS: "x",
      EMAIL_HEALTH_MAX_STUCK: "-5", // invalid → default 0
    });
    expect(t.windowMinutes).toBe(120);
    expect(t.maxFailureRatio).toBe(0.2);
    expect(t.maxStuck).toBe(0);
  });
});

describe("projectEmailRuntimeReadiness", () => {
  it("projects configured and dispatchable core email groups without leaking env values", () => {
    const resendKey = "re_live_do_not_expose";
    const unsubscribeSecret = "unsubscribe_do_not_expose";
    const result = projectEmailRuntimeReadiness({
      RESEND_API_KEY: resendKey,
      SUPABASE_URL: "https://project.supabase.co",
      UNSUBSCRIBE_TOKEN_SECRET: unsubscribeSecret,
    });

    expect(result).toEqual({
      configured: { provider: true, emailOrigin: true },
      dispatch: {
        allRequestedGroupsReady: true,
        requestedGroupCount: 2,
        readyGroupCount: 2,
        requestedGroups: ["transactional_email", "subscription_email"],
        readyGroups: ["transactional_email", "subscription_email"],
        blockedGroups: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain(resendKey);
    expect(JSON.stringify(result)).not.toContain(unsubscribeSecret);
    expect(JSON.stringify(result)).not.toContain("project.supabase.co");
  });

  it("identifies an enabled marketing group as blocked without exposing its cause", () => {
    const result = projectEmailRuntimeReadiness({
      RESEND_API_KEY: "re_test",
      SUPABASE_URL: "https://project.supabase.co",
      COMMERCE_ABANDONED_CART_ENABLED: "true",
    });

    expect(result).toEqual({
      configured: { provider: true, emailOrigin: true },
      dispatch: {
        allRequestedGroupsReady: false,
        requestedGroupCount: 3,
        readyGroupCount: 2,
        requestedGroups: ["transactional_email", "subscription_email", "marketing_email"],
        readyGroups: ["transactional_email", "subscription_email"],
        blockedGroups: ["marketing_email"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("unsubscribe_token_secret_required");
  });
});

// --- cron-level auth / flag / wiring ---

function req(method = "GET", authorization?: string): VercelRequest {
  return { method, headers: authorization ? { authorization } : {} } as unknown as VercelRequest;
}

/** Fake Supabase client returning canned counts keyed by the status filter. */
function fakeClient(countsByKey: Record<string, number>, notificationControls: Record<string, boolean> = {}) {
  return {
    from(table: string) {
      if (table === "comms_notification_controls") {
        return {
          select() {
            return {
              in() {
                return Promise.resolve({
                  data: Object.entries(notificationControls).map(([slug, enabled]) => ({ slug, enabled })),
                  error: null,
                });
              },
            };
          },
        };
      }
      const state: { single?: string; statuses?: string[]; lt?: string } = {};
      const q = {
        in(col: string, vals: readonly string[]) {
          if (col === "status") state.statuses = [...vals];
          return q;
        },
        eq(col: string, val: string) {
          if (col === "status") state.single = val;
          return q;
        },
        gte() {
          return q;
        },
        lt(col: string) {
          state.lt = col;
          return q;
        },
        then(resolve: (v: { count: number; error: null }) => unknown) {
          const key = state.single
            ? `eq:${state.single}${state.lt ? `:${state.lt}` : ""}`
            : `in:${(state.statuses ?? []).join(",")}`;
          return Promise.resolve({ count: countsByKey[key] ?? 0, error: null }).then(resolve);
        },
      };
      return { select: () => q };
    },
  } as never;
}

function fakeGateway(client: unknown) {
  return (_env: SupabaseDataGatewayEnv): DataGatewayPort => ({
    asActor: async () => {
      throw new Error("unexpected_actor_gateway_call");
    },
    asService: async (work) => work(client),
  });
}

const BASE_ENV = {
  CRON_SECRET: "s3cret",
  COMMERCE_EMAIL_HEALTH_WATCHDOG_ENABLED: "true",
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  RESEND_API_KEY: "re_test",
};

describe("runEmailHealthWatchdogCron", () => {
  it("requires CRON_SECRET to be configured", async () => {
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer x"), {});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("cron_secret_required");
  });

  it("rejects a bad bearer token", async () => {
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer nope"), { CRON_SECRET: "s3cret" });
    expect(res.status).toBe(401);
  });

  it("returns 503 when the flag is off but the default-on dispatcher can still send customer email", async () => {
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer s3cret"), {
      CRON_SECRET: "s3cret",
      RESEND_API_KEY: "re_live_do_not_expose",
      SUPABASE_URL: "https://project.supabase.co",
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ok: false,
      error: "email_health_watchdog_disabled_while_customer_email_active",
      activeCustomerEmailFlows: ["COMMERCE_OUTBOX_DISPATCH_ENABLED"],
      runtimeReadiness: {
        configured: { provider: true, emailOrigin: true },
        dispatch: { allRequestedGroupsReady: true },
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("re_live_do_not_expose");
  });

  it("skips only when every customer email flow is explicitly inactive", async () => {
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer s3cret"), {
      CRON_SECRET: "s3cret",
      COMMERCE_OUTBOX_DISPATCH_ENABLED: "false",
    });

    expect(res).toMatchObject({
      status: 200,
      body: {
        ok: true,
        skipped: true,
        reason: "email_health_watchdog_disabled",
      },
    });
  });

  it("returns 503 for another active customer-email flow when the dispatcher is explicitly off", async () => {
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer s3cret"), {
      CRON_SECRET: "s3cret",
      COMMERCE_OUTBOX_DISPATCH_ENABLED: "false",
      COMMERCE_DUNNING_EMAILS_ENABLED: "true",
    });

    expect(res).toMatchObject({
      status: 503,
      body: {
        ok: false,
        error: "email_health_watchdog_disabled_while_customer_email_active",
        activeCustomerEmailFlows: ["COMMERCE_DUNNING_EMAILS_ENABLED"],
      },
    });
  });

  it("returns sanitized runtime readiness when metrics cannot be queried", async () => {
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer s3cret"), {
      CRON_SECRET: "s3cret",
      COMMERCE_EMAIL_HEALTH_WATCHDOG_ENABLED: "true",
      RESEND_API_KEY: "re_live_do_not_expose",
    });

    expect(res).toMatchObject({
      status: 503,
      body: {
        ok: false,
        error: "supabase_env_required",
        runtimeReadiness: {
          configured: { provider: true, emailOrigin: true },
          dispatch: { allRequestedGroupsReady: true },
        },
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("re_live_do_not_expose");
  });

  it("returns 200 when healthy", async () => {
    const counts = {
      "in:sent,delivered,delivery_delayed,failed,bounced,complained,missed": 30,
      "in:sent,delivered": 30,
      "in:failed,bounced,complained,missed": 0,
      "eq:delivery_delayed": 0,
      "eq:processing:updated_at": 0,
      "in:planned,queued": 0,
    };
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer s3cret"), BASE_ENV, fakeGateway(fakeClient(counts)));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.runtimeReadiness).toMatchObject({
      configured: { provider: true, emailOrigin: true },
      dispatch: {
        allRequestedGroupsReady: true,
        blockedGroups: [],
      },
    });
  });

  it("returns 503 when the failure ratio is breached", async () => {
    const counts = {
      "in:sent,delivered,delivery_delayed,failed,bounced,complained,missed": 20,
      "in:sent,delivered": 4,
      "in:failed,bounced,complained,missed": 16,
      "eq:delivery_delayed": 0,
      "eq:processing:updated_at": 0,
      "in:planned,queued": 0,
    };
    const res = await runEmailHealthWatchdogCron(req("GET", "Bearer s3cret"), BASE_ENV, fakeGateway(fakeClient(counts)));
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect((res.body.breaches as { code: string }[]).map((b) => b.code)).toContain("failure_ratio");
  });

  it("returns 503 when an active email handler group is not dispatchable", async () => {
    const counts = {
      "in:sent,delivered,delivery_delayed,failed,bounced,complained,missed": 30,
      "in:sent,delivered": 30,
      "in:failed,bounced,complained,missed": 0,
      "eq:delivery_delayed": 0,
      "eq:processing:updated_at": 0,
      "in:planned,queued": 0,
    };
    const res = await runEmailHealthWatchdogCron(
      req("GET", "Bearer s3cret"),
      { ...BASE_ENV, COMMERCE_ABANDONED_CART_ENABLED: "true" },
      fakeGateway(fakeClient(counts)),
    );

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect((res.body.breaches as { code: string }[]).map((breach) => breach.code)).toContain("runtime_readiness");
    expect(res.body.runtimeReadiness).toMatchObject({
      dispatch: { blockedGroups: ["marketing_email"] },
    });
    expect(JSON.stringify(res.body)).not.toContain("unsubscribe_token_secret_required");
  });

  it("returns 503 when an explicit notification control would terminally skip a mandatory customer email", async () => {
    const counts = {
      "in:sent,delivered,delivery_delayed,failed,bounced,complained,missed": 30,
      "in:sent,delivered": 30,
      "in:failed,bounced,complained,missed": 0,
      "eq:delivery_delayed": 0,
      "eq:processing:updated_at": 0,
      "in:planned,queued": 0,
    };
    const res = await runEmailHealthWatchdogCron(
      req("GET", "Bearer s3cret"),
      BASE_ENV,
      fakeGateway(fakeClient(counts, { "commerce-order-paid": false })),
    );

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect((res.body.breaches as { code: string }[]).map((breach) => breach.code)).toContain("notification_controls_disabled");
    expect(res.body.runtimeReadiness).toMatchObject({
      notificationControls: {
        disabledControlCount: 1,
        disabledControlKeys: ["commerce-order-paid"],
      },
    });
  });
});
