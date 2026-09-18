import { describe, expect, it, vi } from "vitest";

import { resolveSubscriberRetentionMessagingBinding } from "./subscriberRetentionMessagingBinding.js";

const SUBSCRIPTION = "11111111-1111-4111-8111-111111111111";

describe("subscriber retention messaging production binding", () => {
  it("binds only the direct bundle with a connection string", () => {
    expect(resolveSubscriberRetentionMessagingBinding({
      PLATFORM_BUNDLE: "vercel-supabase",
      DATABASE_URL: "postgres://db",
    })).toEqual({ error: "subscriber_retention_bundle_unbound" });
    expect(resolveSubscriberRetentionMessagingBinding({
      PLATFORM_BUNDLE: "node-postgres",
    })).toEqual({ error: "database_url_required" });
  });

  it("composes the exported domain owner and closes its pool", async () => {
    const end = vi.fn(async () => undefined);
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("subscriber_retention_create_intent");
      return { rows: [{ result: {
        intentId: "22222222-2222-4222-8222-222222222222",
        subjectReference: "subject-1",
        subscriptionId: SUBSCRIPTION,
        sourceReference: `subscription:${SUBSCRIPTION}`,
        kind: "winback",
        templateReference: "subscriber-winback-v1",
        fingerprint: "a".repeat(64),
        status: "refused",
        refusal: "consent_missing",
        deliveryReference: null,
        attemptCount: 0,
        replayed: false,
      } }] };
    });
    const delivery = { send: vi.fn(), readReceipt: vi.fn() };
    const resolved = resolveSubscriberRetentionMessagingBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://db",
    }, {
      createPool: () => ({ query, end }),
      deliveryBinding: { identity: "node-postgres", run: (work) => work(delivery as never) },
    });
    expect(resolved.binding).toBeDefined();
    await expect(resolved.binding!.run((messaging) => messaging.deliverIntent({
      idempotencyKey: "retention-intent-1",
      subjectReference: "subject-1",
      subscriptionId: SUBSCRIPTION,
      sourceReference: `subscription:${SUBSCRIPTION}`,
      kind: "winback",
      templateReference: "subscriber-winback-v1",
      expectedRevision: 1,
      recipientFingerprint: "b".repeat(64),
      controlKey: "subscriber-retention",
      consentPurpose: "retention_marketing",
    }))).resolves.toMatchObject({ status: "refused", refusal: "consent_missing" });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });
});
