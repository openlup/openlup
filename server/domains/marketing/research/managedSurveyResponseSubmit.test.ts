import { describe, expect, it, vi } from "vitest";
import { createManagedSurveyResponseSubmit } from "./managedSurveyResponseSubmit.js";

const request = { surveyType: "producer" as const, responseData: { role: "Founder" } };

describe("managed survey response submit", () => {
  it("rejects malformed payloads before rate-limit or persistence effects", async () => {
    const deps = fixture();

    await expect(createManagedSurveyResponseSubmit(deps)({ surveyType: "producer", responseData: {} }, new Headers())).resolves.toEqual({
      ok: false, error: "invalid_response_data",
    });
    expect(deps.gateway.checkRateLimit).not.toHaveBeenCalled();
    expect(deps.gateway.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", "survey_rate_limit_unavailable"],
    ["limited", "survey_rate_limited"],
  ] as const)("fails closed when the per-IP limiter is %s", async (rate, error) => {
    const deps = fixture({ rate });

    await expect(createManagedSurveyResponseSubmit(deps)(request, new Headers())).resolves.toEqual({ ok: false, error });
    expect(deps.gateway.insert).not.toHaveBeenCalled();
    expect(deps.delivery.deliver).not.toHaveBeenCalled();
  });

  it("persists before missing-recipient handling and explicitly marks notification skipped", async () => {
    const events: string[] = [];
    const deps = fixture({ events, notifyTo: [] });

    await expect(createManagedSurveyResponseSubmit(deps)(request, new Headers({ "x-forwarded-for": "198.51.100.9" }))).resolves.toEqual({
      ok: true, id: "survey-1", email_skipped: "notification_recipient_not_configured",
    });
    expect(events).toEqual(["rate", "insert", "update:notification_recipient_not_configured"]);
    expect(deps.gateway.insert).toHaveBeenCalledWith(expect.objectContaining({
      table: "survey_responses_producer", ip: "198.51.100.9", responseData: request.responseData,
    }));
    expect(deps.delivery.deliver).not.toHaveBeenCalled();
  });

  it("preserves the row when the admin policy denies notification", async () => {
    const deps = fixture({ policyAllowed: false });

    await expect(createManagedSurveyResponseSubmit(deps)(request, new Headers())).resolves.toEqual({
      ok: true, id: "survey-1", email_skipped: "policy_blocked",
    });
    expect(deps.gateway.updateEmailStatus).toHaveBeenCalledWith(expect.objectContaining({ sentAt: null, error: "policy_blocked" }));
    expect(deps.delivery.deliver).not.toHaveBeenCalled();
  });

  it("evaluates each admin recipient independently and sends only allowed decisions", async () => {
    const notifyTo = ["deny@example.com", "allow-one@example.com", "allow-two@example.com"];
    const deps = fixture({
      notifyTo,
      policyByEmail: {
        "deny@example.com": { allowed: false, reason: "admin_denied", decisionId: "admin-1" },
        "allow-one@example.com": { allowed: true, reason: "admin_allowed_one", decisionId: "admin-2" },
        "allow-two@example.com": { allowed: true, reason: "admin_allowed_two", decisionId: "admin-3" },
      },
    });

    await expect(createManagedSurveyResponseSubmit(deps)(request, new Headers())).resolves.toEqual({ ok: true, id: "survey-1" });

    expect(deps.delivery.evaluatePolicy).toHaveBeenCalledTimes(3);
    expect(deps.delivery.evaluatePolicy.mock.calls.map(([input]) => input.email)).toEqual(notifyTo);
    expect(deps.delivery.deliver.mock.calls.map(([input]) => input.recipientEmail)).toEqual(["allow-one@example.com", "allow-two@example.com"]);
    expect(deps.delivery.deliver.mock.calls.map(([input]) => input.policyDecisionId)).toEqual(["admin-2", "admin-3"]);
    expect(deps.delivery.deliver.mock.calls.map(([input]) => input.metadata)).toEqual([
      { surveyResponseId: "survey-1", policyReason: "admin_allowed_one" },
      { surveyResponseId: "survey-1", policyReason: "admin_allowed_two" },
    ]);
    expect(deps.delivery.deliver).not.toHaveBeenCalledWith(expect.objectContaining({ recipientEmail: "deny@example.com" }));
  });

  it("keeps the admin audit fail-open reason for every recipient", async () => {
    const reason = "policy_rpc_unavailable_fail_open_with_audit";
    const deps = fixture({
      notifyTo: ["ops-one@example.com", "ops-two@example.com"],
      policyByEmail: {
        "ops-one@example.com": { allowed: true, reason, decisionId: null },
        "ops-two@example.com": { allowed: true, reason, decisionId: null },
      },
    });

    await expect(createManagedSurveyResponseSubmit(deps)(request, new Headers())).resolves.toEqual({ ok: true, id: "survey-1" });
    expect(deps.delivery.deliver).toHaveBeenCalledTimes(2);
    expect(deps.delivery.deliver.mock.calls.map(([input]) => input.metadata)).toEqual([
      { surveyResponseId: "survey-1", policyReason: reason },
      { surveyResponseId: "survey-1", policyReason: reason },
    ]);
  });

  it.each([
    ["suppressed", { accepted: false, messageId: null, skip: "egress_suppressed", error: null }, "egress_suppressed"],
    ["rejected", { accepted: false, messageId: null, skip: null, error: "address_rejected" }, "address_rejected"],
    ["provider acceptance without an ID", { accepted: false, messageId: null, skip: null, error: "provider_accepted_without_message_id" }, "provider_accepted_without_message_id"],
  ] as const)("does not produce sent evidence for %s email", async (_name, deliveryResult, errorCode) => {
    const deps = fixture({ deliveryResult });

    await expect(createManagedSurveyResponseSubmit(deps)(request, new Headers())).resolves.toEqual({ ok: true, id: "survey-1" });
    expect(deps.gateway.updateEmailStatus).toHaveBeenLastCalledWith(expect.objectContaining({ sentAt: null, error: errorCode }));
    expect(deps.delivery.deliver).toHaveBeenCalledOnce();
    expect(deps.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: "survey_producer_notification:survey-1:0",
      message: expect.objectContaining({ to: "ops@example.com" }),
    }));
  });

  it("orders limiter, insert, policy, transport, evidence, and final status", async () => {
    const events: string[] = [];
    const deps = fixture({ events });

    await expect(createManagedSurveyResponseSubmit(deps)(request, new Headers())).resolves.toMatchObject({ ok: true, id: "survey-1" });
    expect(events).toEqual(["rate", "insert", "policy", "deliver", "update:sent"]);
  });
});

function fixture(options: {
  events?: string[];
  rate?: "allowed" | "limited" | "unavailable";
  notifyTo?: string[];
  policyAllowed?: boolean;
  policyByEmail?: Record<string, { allowed: boolean; reason: string; decisionId: string | null }>;
  deliveryResult?: { accepted: boolean; messageId: string | null; skip: string | null; error: string | null };
} = {}) {
  const events = options.events ?? [];
  const deliveryResult = options.deliveryResult ?? { accepted: true, messageId: "mail-1", skip: null, error: null };
  return {
    gateway: {
      checkRateLimit: vi.fn(async () => {
        events.push("rate");
        return options.rate ?? "allowed";
      }),
      insert: vi.fn(async () => {
        events.push("insert");
        return { id: "survey-1" };
      }),
      updateEmailStatus: vi.fn(async (input: { error: string | null }) => {
        events.push(`update:${input.error ?? "sent"}`);
      }),
    },
    delivery: {
      evaluatePolicy: vi.fn(async (input: { email?: string | null }) => {
        events.push("policy");
        return options.policyByEmail?.[input.email ?? ""] ?? { allowed: options.policyAllowed ?? true, reason: "policy_blocked", decisionId: "decision-1" };
      }),
      deliver: vi.fn(async (_input: { recipientEmail?: string; policyDecisionId?: string | null; metadata?: Record<string, unknown> }) => {
        events.push("deliver");
        return deliveryResult;
      }),
    },
    notifyTo: options.notifyTo ?? ["ops@example.com"],
    fromEmail: "openlup <hello@example.com>",
    windowMinutes: 60,
    maxPerIp: 20,
    now: () => new Date("2026-08-20T10:00:00.000Z"),
  };
}
