import { describe, expect, it, vi } from "vitest";
import { publicIntakeEmailResult, publicIntakeEmailTransport, type PublicIntakeEmailOutcomeFixture } from "../../../tests/helpers/publicIntakeEmailDeliveryFixture.js";
import { createPublicIntakeEmailDeliveryPort, type PublicIntakeEmailDeliveryClient } from "./publicIntakeEmailDeliveryPort.js";

describe("public intake email delivery port", () => {
  it("fails closed for an unreadable external policy decision and fails open for admin delivery", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const delivery = createPublicIntakeEmailDeliveryPort({ client: client(rpc), transport: publicIntakeEmailTransport() });
    await expect(delivery.evaluatePolicy({ email: "buyer@example.com", purpose: "transactional", source: "b2b", recipientKind: "external_contact", metadata: {} })).resolves.toMatchObject({ allowed: false, reason: "policy_response_unreadable_fail_closed" });
    await expect(delivery.evaluatePolicy({ email: "ops@example.com", purpose: "admin_notification", source: "survey", recipientKind: "admin_internal", metadata: {} })).resolves.toMatchObject({ allowed: true, reason: "policy_response_unreadable_fail_open_with_audit" });
  });

  it("fails closed for an unwired external policy engine and keeps the admin audit path open", async () => {
    const delivery = createPublicIntakeEmailDeliveryPort({ client: {} as PublicIntakeEmailDeliveryClient, transport: publicIntakeEmailTransport() });
    await expect(delivery.evaluatePolicy({ email: "buyer@example.com", purpose: "transactional", source: "b2b", recipientKind: "external_contact", metadata: {} })).resolves.toMatchObject({ allowed: false, reason: "policy_rpc_unavailable_fail_closed" });
    await expect(delivery.evaluatePolicy({ email: "ops@example.com", purpose: "admin_notification", source: "survey", recipientKind: "admin_internal", metadata: {} })).resolves.toMatchObject({ allowed: true, reason: "policy_rpc_unavailable_fail_open_with_audit" });
  });

  it("links recipient-scoped policy decisions to distinct audited delivery evidence", async () => {
    const rows: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === "communication_evaluate_email_policy") {
        const email = String(params.p_email);
        return { data: { allowed: true, reason: `allowed:${email}`, decisionId: `decision:${email}` }, error: null };
      }
      if (name === "communication_record_email_delivery") return { data: `timeline:${params.p_dedupe_key}`, error: null };
      return { data: null, error: null };
    });
    const delivery = createPublicIntakeEmailDeliveryPort({ client: client(rpc, rows), transport: publicIntakeEmailTransport() });
    const recipients = ["ops-one@example.com", "ops-two@example.com"];
    const decisions = await Promise.all(recipients.map((email) => delivery.evaluatePolicy({
      email, purpose: "admin_notification", source: "survey", recipientKind: "admin_internal", metadata: { recipient_index: recipients.indexOf(email) },
    })));

    await Promise.all(recipients.map((recipient, index) => delivery.deliver({
      source: "submit-survey-response", templateSlug: "survey_producer_notification", policyDecisionId: decisions[index]!.decisionId,
      dedupeKey: `survey:1:${index}`, purpose: "admin_notification", triggerEvent: "survey_response_submitted",
      recipientEmail: recipient, aggregateType: "survey_response", aggregateId: "survey-1",
      metadata: { policyReason: decisions[index]!.reason },
      message: { sender: "openlup <hello@example.com>", to: recipient, subject: "Survey", html: "<p>Survey</p>" },
    })));

    expect(rpc.mock.calls.filter(([name]) => name === "communication_evaluate_email_policy").map(([, params]) => params.p_email)).toEqual(recipients);
    expect(rpc.mock.calls.filter(([name]) => name === "communication_link_send_decision").map(([, params]) => ({
      decisionId: params.p_decision_id, emailSendId: params.p_email_send_id,
    }))).toEqual([
      { decisionId: "decision:ops-one@example.com", emailSendId: "send-1" },
      { decisionId: "decision:ops-two@example.com", emailSendId: "send-2" },
    ]);
    expect(rows.map((row) => row.provider_response)).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyReason: "allowed:ops-one@example.com", sendAttemptId: "timeline:survey:1:0" }),
      expect.objectContaining({ policyReason: "allowed:ops-two@example.com", sendAttemptId: "timeline:survey:1:1" }),
    ]));
  });

  it.each<[string, PublicIntakeEmailOutcomeFixture, { accepted: boolean; messageId: string | null; skip: string | null; error: string | null }, string, string, string]>([
    ["suppressed", { ok: true, messageId: null, suppressed: "drop" }, { accepted: false, messageId: null, skip: "egress_suppressed", error: null }, "skipped", "skipped", "egress_suppressed"],
    ["rejected", { ok: false, messageId: null, providerError: "Address rejected" }, { accepted: false, messageId: null, skip: null, error: "address_rejected" }, "failed", "failed", "address_rejected"],
    ["acceptance without an ID", { ok: true, messageId: null }, { accepted: false, messageId: null, skip: null, error: "provider_accepted_without_message_id" }, "failed", "delivery_delayed", "provider_accepted_without_message_id"],
  ])("does not report %s delivery as accepted", async (_name, outcome, expectedResult, expectedLedgerStatus, expectedTimelineStatus, expectedError) => {
    const rows: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (name: string) => name === "communication_record_email_delivery" ? { data: "delivery-1", error: null } : { data: null, error: null });
    const rawResult = publicIntakeEmailResult(outcome);
    const rawOutcomeBefore = structuredClone(rawResult.outcome);
    const emailTransport = publicIntakeEmailTransport(rawResult);
    const delivery = createPublicIntakeEmailDeliveryPort({ client: client(rpc, rows), transport: emailTransport });
    await expect(delivery.deliver({ source: "submit-survey-response", templateSlug: "survey_producer_notification", policyDecisionId: null, dedupeKey: "survey:1:0", purpose: "admin_notification", triggerEvent: "survey_response_submitted", recipientEmail: "ops@example.com", aggregateType: "survey_response", aggregateId: "survey-1", metadata: {}, message: { sender: "openlup <hello@example.com>", to: "ops@example.com", subject: "Survey", html: "<p>Survey</p>" } })).resolves.toEqual(expectedResult);
    expect(emailTransport.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "survey:1:0" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: expectedLedgerStatus, sent_at: null, provider_error: expectedError, provider_response: expect.objectContaining(rawResult.providerResponse) });
    expect(rawResult.outcome).toEqual(rawOutcomeBefore);
    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({ p_status: expectedTimelineStatus, p_last_error_code: expectedError, p_provider_message_id: null, p_provider_kind: "in-memory" }));
  });
});

function client(rpc: ReturnType<typeof vi.fn>, rows: Record<string, unknown>[] = []): PublicIntakeEmailDeliveryClient {
  return { rpc: rpc as NonNullable<PublicIntakeEmailDeliveryClient["rpc"]>, from: vi.fn(() => ({ insert: (row: Record<string, unknown>) => ({ select: () => ({ maybeSingle: async () => { rows.push(row); return { data: { id: `send-${rows.length}` }, error: null }; } }) }) })) };
}
