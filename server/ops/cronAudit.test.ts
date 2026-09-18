import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../_lib/types/vercel.js";
import type { SupabaseDataGatewayEnv } from "../adapters/supabase/dataGatewayClientFactory.js";
import { runCronAudit } from "./cronAudit.js";
import { summarizeDelayedFeedback, summarizeDhlRows, summarizeRetiredRewardEvidence } from "./cronAuditSummaries.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";

function request(headers: Record<string, string> = {}, method = "GET", query = {}): VercelRequest {
  return {
    method,
    headers,
    query,
  } as VercelRequest;
}

describe("ops cron audit route", () => {
  it("keeps the ops route on the DataGatewayPort boundary", () => {
    const source = readFileSync("server/ops/cronAudit.ts", "utf8");

    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toMatch(/\bcreateClient\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain("readSupabaseDataGatewayEnv");
    expect(source).toContain(".asService(");
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    const gateway = gatewayFactory({});

    await expect(runCronAudit(request(), {}, new Date(), gateway.factory)).resolves.toEqual({
      status: 500,
      body: { ok: false, error: "cron_secret_not_configured" },
    });
    expect(gateway.factory).not.toHaveBeenCalled();
  });

  it("rejects requests without the bearer secret", async () => {
    const gateway = gatewayFactory({});

    await expect(
      runCronAudit(
        request({ authorization: "Bearer wrong" }),
        { CRON_SECRET: "cron-secret", SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role" },
        new Date(),
        gateway.factory,
      ),
    ).resolves.toEqual({
      status: 401,
      body: { ok: false, error: "unauthorized" },
    });
    expect(gateway.factory).not.toHaveBeenCalled();
  });

  it("requires service role config after auth succeeds", async () => {
    const gateway = gatewayFactory({});

    await expect(
      runCronAudit(
        request({ authorization: "Bearer cron-secret" }),
        { CRON_SECRET: "cron-secret", SUPABASE_URL: "https://example.supabase.co" },
        new Date(),
        gateway.factory,
      ),
    ).resolves.toEqual({
      status: 500,
      body: { ok: false, error: "supabase_service_role_not_configured" },
    });
    expect(gateway.factory).not.toHaveBeenCalled();
  });

  it("runs authorized audit work through asService", async () => {
    const client = cronAuditClient();
    const gateway = gatewayFactory(client);

    const result = await runCronAudit(
      request({ authorization: "Bearer cron-secret" }, "GET", { lookbackHours: "24" }),
      {
        CRON_SECRET: "cron-secret",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
      },
      new Date("2026-06-02T12:00:00.000Z"),
      gateway.factory,
    );

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.lookbackHours).toBe(24);
    expect(result.body.rewardConfirmation).toEqual({
      mode: "retired_no_send",
      expectedOutboxStatus: "processed",
      expectedDeliveryStatus: "skipped",
      expectedSkipReason: "tester_program_retired_no_egress",
      completedFeedbackRows: 0,
      outboxRows: 0,
      retirementRows: 0,
      legacyTerminalRows: 0,
      legacyProviderSuccessCount: 0,
      legacyAmbiguousCount: 0,
      legacyDiscardedCount: 0,
      deliveryRows: 0,
      backlogCount: 0,
      invalidOutboxCount: 0,
      missingDeliveryCount: 0,
      invalidDeliveryCount: 0,
      forbiddenProviderEvidenceCount: 0,
      missingRewardConfirmationCount: 0,
      sentCount: 0,
      ok: true,
    });
    expect(gateway.factory).toHaveBeenCalledWith({
      url: "https://example.supabase.co",
      anonKey: "",
      serviceRoleKey: "service-role",
    });
    expect(gateway.asService).toHaveBeenCalledTimes(1);
  });

  it("reads retired reward truth from the outbox and delivery ledgers without email_sends", () => {
    const report = readFileSync("server/ops/cronAuditReport.ts", "utf8");
    const types = readFileSync("server/ops/cronAuditTypes.ts", "utf8");

    expect(report).not.toContain('"reward_confirmation_sends"');
    expect(report).toContain('table<RewardOutboxAuditRow>(client, "outbox_events")');
    expect(report).toContain('table<RewardDeliveryAuditRow>(client, "communication_email_deliveries")');
    expect(report).not.toContain('.is("processed_at", null)');
    expect(report).not.toContain('table<EmailSendRow>(client, "email_sends").eq("template_slug", RETIRED_REWARD_TEMPLATE)');
    expect(types).not.toContain('"reward-confirmation",');
  });

  it("accepts only processed/skipped reward evidence with no provider trace", () => {
    expect(summarizeRetiredRewardEvidence({
      completedFeedbackRows: [{ id: "feedback-1", tester_id: "tester-1", hash: null, submitted_at: null }],
      recentOutboxRows: [{ id: "event-1", aggregate_id: "tester-1", status: "processed", processed_at: "2026-06-02T00:00:00Z", metadata: { skipped: "tester_program_retired_no_egress" }, payload: { feedbackId: "feedback-1" } }],
      unresolvedOutboxRows: [],
      deliveryRows: [{ outbox_event_id: "event-1", status: "skipped", last_error_code: "tester_program_retired_no_egress", provider_kind: null, provider_message_id: null, email_send_id: null, sent_at: null, delivered_at: null, metadata: {} }],
    })).toMatchObject({ ok: true, backlogCount: 0, forbiddenProviderEvidenceCount: 0 });
  });

  it("flags reward backlog, bad terminal state, and forbidden provider evidence", () => {
    expect(summarizeRetiredRewardEvidence({
      completedFeedbackRows: [{ id: "feedback-missing", tester_id: "tester-1", hash: null, submitted_at: null }],
      recentOutboxRows: [{ id: "discarded", aggregate_id: "tester-3", status: "discarded", processed_at: null, metadata: { skipped: "tester_program_retired_no_egress" }, payload: { feedbackId: "feedback-3" } }],
      unresolvedOutboxRows: [{ id: "pending", aggregate_id: "tester-2", status: "pending", processed_at: null, metadata: {}, payload: { feedbackId: "feedback-2" } }],
      deliveryRows: [{ outbox_event_id: "discarded", status: "sent", last_error_code: null, provider_kind: "resend", provider_message_id: "re-1", email_send_id: "send-1", sent_at: "2026-06-02T00:00:00Z", delivered_at: null, metadata: {} }],
    })).toMatchObject({
      ok: false,
      backlogCount: 1,
      invalidOutboxCount: 1,
      missingDeliveryCount: 0,
      invalidDeliveryCount: 1,
      forbiddenProviderEvidenceCount: 1,
      missingRewardConfirmationCount: 1,
    });
  });

  it("catches old unresolved work but ignores legitimate pre-retirement sent history", () => {
    const result = summarizeRetiredRewardEvidence({
      completedFeedbackRows: [],
      recentOutboxRows: [{ id: "legacy-sent", aggregate_id: "tester-1", status: "processed", processed_at: "2026-05-01T00:00:00Z", metadata: { resendId: "re-old" }, payload: { feedbackId: "feedback-old" } }],
      unresolvedOutboxRows: [{ id: "old-pending", aggregate_id: "tester-2", status: "pending", processed_at: "2026-05-01T00:00:00Z", metadata: {}, payload: { feedbackId: "feedback-pending" } }],
      deliveryRows: [],
    });

    expect(result).toMatchObject({
      ok: false,
      backlogCount: 1,
      retirementRows: 0,
      legacyTerminalRows: 1,
      legacyProviderSuccessCount: 1,
      forbiddenProviderEvidenceCount: 0,
    });
  });

  it("reports legacy terminal truth without a false retirement failure", () => {
    const legacy = (id: string, status: string, metadata: Record<string, unknown>) => ({
      id, aggregate_id: `tester-${id}`, status, processed_at: "2026-05-01T00:00:00Z",
      metadata, payload: { feedbackId: `feedback-${id}` },
    });
    const result = summarizeRetiredRewardEvidence({
      completedFeedbackRows: [],
      recentOutboxRows: [
        legacy("provider", "processed", { resendId: "re-old" }),
        legacy("ambiguous", "processed", { acceptedWithoutProviderId: true }),
        legacy("discarded", "discarded", { discardReason: "resend_idempotency_window_expired_manual_review" }),
      ],
      unresolvedOutboxRows: [], deliveryRows: [],
    });

    expect(result).toMatchObject({
      ok: true, retirementRows: 0, legacyTerminalRows: 3,
      legacyProviderSuccessCount: 1, legacyAmbiguousCount: 1, legacyDiscardedCount: 1,
      forbiddenProviderEvidenceCount: 0,
    });
  });
});

describe("ops cron audit summaries", () => {
  it("reports the next delayed feedback action without skipping ahead", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    const result = summarizeDelayedFeedback({
      now,
      testers: [
        {
          id: "tester-mid",
          status: "delivered",
          delivered_at: "2026-05-30T12:00:00.000Z",
          email_sequence_paused: false,
        },
        {
          id: "tester-final",
          status: "feedback_mid",
          delivered_at: "2026-05-27T12:00:00.000Z",
          email_sequence_paused: false,
        },
        {
          id: "tester-missing-hash",
          status: "delivered",
          delivered_at: "2026-05-28T12:00:00.000Z",
          email_sequence_paused: false,
        },
      ],
      feedbackRows: [
        { tester_id: "tester-mid", hash: "hash-mid", submitted_at: null },
        { tester_id: "tester-final", hash: "hash-final", submitted_at: null },
        { tester_id: "tester-missing-hash", hash: null, submitted_at: null },
      ],
      sends: [
        {
          id: "send-mid",
          tester_id: "tester-final",
          template_slug: "feedback-mid",
          status: "sent",
          sent_at: "2026-05-29T12:00:00.000Z",
          resend_id: "resend-mid",
        },
      ],
    });

    expect(result.nextActionCounts).toEqual({
      "feedback-mid": 1,
      "feedback-final": 1,
    });
    expect(result.missingFeedbackHashCount).toBe(1);
    expect(result.alreadySubmittedCount).toBe(0);
  });

  it("reports already-submitted feedback without scheduling another prompt", () => {
    const result = summarizeDelayedFeedback({
      now: new Date("2026-06-08T12:00:00.000Z"),
      testers: [
        {
          id: "tester-submitted",
          status: "feedback_mid",
          delivered_at: "2026-06-01T12:00:00.000Z",
          email_sequence_paused: false,
        },
      ],
      feedbackRows: [
        { tester_id: "tester-submitted", hash: "hash-submitted", submitted_at: "2026-06-04T12:00:00.000Z" },
      ],
      sends: [
        {
          id: "send-mid",
          tester_id: "tester-submitted",
          template_slug: "feedback-mid",
          status: "sent",
          sent_at: "2026-06-03T12:00:00.000Z",
          resend_id: "resend-mid",
        },
      ],
    });

    expect(result.nextActionCounts).toEqual({});
    expect(result.alreadySubmittedCount).toBe(1);
  });

  it("groups DHL rows by status and last DHL codes", () => {
    const result = summarizeDhlRows([
      {
        id: "tester-1",
        status: "shipped",
        delivered_at: null,
        email_sequence_paused: false,
        dhl_last_checked_at: "2026-06-01T00:00:00.000Z",
        dhl_last_codes: ["EDWP"],
      },
      {
        id: "tester-2",
        status: "shipped",
        delivered_at: null,
        email_sequence_paused: false,
        dhl_last_checked_at: "2026-06-02T11:00:00.000Z",
        dhl_last_codes: ["EDWP"],
      },
    ], new Date("2026-06-02T12:00:00.000Z"), 6);

    expect(result.trackedRows).toBe(2);
    expect(result.staleCount).toBe(1);
    expect(result.byStatusAndCodes).toEqual([
      {
        status: "shipped",
        dhl_last_codes: ["EDWP"],
        count: 2,
        oldest_check: "2026-06-01T00:00:00.000Z",
        newest_check: "2026-06-02T11:00:00.000Z",
      },
    ]);
  });
});

function gatewayFactory(client: unknown) {
  const asService = vi.fn(async <T>(work: (gateway: unknown) => Promise<T>) => work(client));
  const factory = vi.fn((_env: SupabaseDataGatewayEnv): DataGatewayPort => ({
    asActor: vi.fn() as unknown as DataGatewayPort["asActor"],
    asService: asService as unknown as DataGatewayPort["asService"],
  }));
  return { factory, asService };
}

function cronAuditClient() {
  return {
    from: () => emptyQuery(),
  };
}

function emptyQuery() {
  const builder = {
    select: () => builder,
    gte: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    not: () => builder,
    eq: () => builder,
    is: () => builder,
    neq: () => builder,
    then(resolve: (value: { data: unknown[]; count: number; error: null }) => void) {
      resolve({ data: [], count: 0, error: null });
    },
  };
  return builder;
}
