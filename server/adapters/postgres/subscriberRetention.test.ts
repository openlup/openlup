import { describe, expect, it, vi } from "vitest";

import { createPostgresSubscriberRetentionPort } from "./subscriberRetention.js";

const INTENT = {
  intentId: "11111111-1111-4111-8111-111111111111",
  subjectReference: "subject-1",
  subscriptionId: "22222222-2222-4222-8222-222222222222",
  sourceReference: "subscription:22222222-2222-4222-8222-222222222222",
  accessGrantReference: null,
  kind: "winback",
  templateReference: "subscriber-winback-v1",
  fingerprint: "a".repeat(64),
  status: "planned",
  refusal: null,
  deliveryReference: null,
  attemptCount: 0,
  replayed: false,
};

function clientAnswering(data: unknown) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data, error: null }));
  return { rpc, port: createPostgresSubscriberRetentionPort({ rpc }) };
}

describe("postgres subscriber retention adapter", () => {
  it("maps the neutral intent to one named routine without message content", async () => {
    const { rpc, port } = clientAnswering(INTENT);
    await expect(port.createIntent({
      idempotencyKey: "retention-intent-1",
      subjectReference: "subject-1",
      subscriptionId: INTENT.subscriptionId,
      sourceReference: INTENT.sourceReference,
      kind: "winback",
      templateReference: "subscriber-winback-v1",
      fingerprint: "a".repeat(64),
      expectedRevision: 3,
      recipientFingerprint: "b".repeat(64),
      controlKey: "subscriber-retention",
      consentPurpose: "retention_marketing",
    })).resolves.toEqual(INTENT);
    expect(rpc).toHaveBeenCalledWith("subscriber_retention_create_intent", {
      p_idempotency_key: "retention-intent-1",
      p_subject_reference: "subject-1",
      p_subscription_id: INTENT.subscriptionId,
      p_source_reference: INTENT.sourceReference,
      p_kind: "winback",
      p_template_reference: "subscriber-winback-v1",
      p_fingerprint: "a".repeat(64),
      p_expected_revision: 3,
      p_recipient_fingerprint: "b".repeat(64),
      p_control_key: "subscriber-retention",
      p_consent_purpose: "retention_marketing",
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/html|messageBody|renderedCopy|provider/);
  });

  it("maps neutral display facts and capabilities from profile readback", async () => {
    const { port } = clientAnswering({
      subjectReference: "subject-1",
      displayName: "Pupil",
      locale: "pl-PL",
      revision: 3,
      displayFacts: { lifeStage: "adult" },
      capabilities: ["paid-cycle-recap"],
    });
    await expect(port.readProfile("subject-1")).resolves.toEqual({
      profile: { subjectReference: "subject-1", displayName: "Pupil", locale: "pl-PL", revision: 3 },
      facts: {
        subjectReference: "subject-1",
        displayFacts: { lifeStage: "adult" },
        capabilities: ["paid-cycle-recap"],
        locale: "pl-PL",
        revision: 3,
      },
    });
  });

  it("lists durable pending work through the bounded capability routine", async () => {
    const pending = [{
      idempotencyKey: "retention-intent-1",
      subjectReference: "subject-1",
      kind: "review_request",
      templateReference: "review-request-v1",
      accessGrantReference: null,
      fingerprint: "a".repeat(64),
      dispatchClaimReference: "retention-claim:11111111-1111-4111-8111-111111111111",
    }];
    const { rpc, port } = clientAnswering(pending);
    await expect(port.listPending("review_request", 200)).resolves.toEqual([{
      idempotencyKey: pending[0].idempotencyKey,
      subjectReference: pending[0].subjectReference,
      kind: pending[0].kind,
      templateReference: pending[0].templateReference,
      accessGrantReference: null,
      fingerprint: pending[0].fingerprint,
      claimReference: pending[0].dispatchClaimReference,
    }]);
    expect(rpc).toHaveBeenCalledWith("subscriber_retention_list_pending", {
      p_kind: "review_request",
      p_limit: 200,
    });
  });

  it("plans due production work before the pending delivery scan", async () => {
    const answer = { scanned: 4, planned: 3, refused: 1, replayed: 0 };
    const { rpc, port } = clientAnswering(answer);
    await expect(port.planDue("review_request", 200)).resolves.toEqual(answer);
    expect(rpc).toHaveBeenCalledWith("subscriber_retention_plan_due", {
      p_kind: "review_request",
      p_limit: 200,
    });
  });

  it("surfaces durable conflict labels and rejects malformed answers", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "23505", message: "subscriber_retention_intent_conflict" },
    }));
    const port = createPostgresSubscriberRetentionPort({ rpc });
    await expect(port.readIntent(INTENT.intentId)).rejects.toMatchObject({
      message: "subscriber_retention_intent_conflict",
      code: "23505",
    });
    await expect(clientAnswering({ status: "maybe" }).port.readIntent(INTENT.intentId))
      .rejects.toThrow("subscriber retention response invalid");
  });
});
