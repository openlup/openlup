import { describe, expect, it, vi } from "vitest";
import { createPostgresLifecycleMessages } from "../../src/subscriptions/postgresLifecycleMessages.js";
import type { SubscriptionQueryExecutor } from "../../src/subscriptions/postgresRenewalStore.js";

describe("createPostgresLifecycleMessages dispatch policy and error visibility", () => {
  it("binds configured dispatch.maxAttempts into the non-dunning source query and reports per-notice errors to onError", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const unlocked: unknown[][] = [];
    const db: SubscriptionQueryExecutor = {
      async query(text, values) {
        queries.push({ text, values });
        if (text.includes("pg_advisory_unlock")) {
          unlocked.push(values ?? []);
          return { rows: [] };
        }
        if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
        if (text.includes("WITH sources AS")) {
          return {
            rows: [{
              id: "evt-1",
              source: "event",
              subscription_id: "sub-1",
              client_id: "cli-1",
              kind: "subscription.activated",
              payload: {},
              outbox: false,
            }],
          };
        }
        if (text.includes("dunning_lifecycle_recipient")) {
          return { rows: [{ recipient: { email: "customer@example.test", firstName: "Alex", country: null } }] };
        }
        if (text.includes("communications_notification_control_enabled")) {
          return { rows: [{ enabled: true }] };
        }
        if (text.includes("communications_recipient_consent_state")) {
          return { rows: [{ state: "unknown" }] };
        }
        return { rows: [] };
      },
    };
    const sendError = new Error("transport timeout");
    const onError = vi.fn(() => {
      throw new Error("error sink failed");
    });
    const runner = createPostgresLifecycleMessages({
      dispatch: { leaseSeconds: 60, maxAttempts: 3, transientBackoffSeconds: 900 },
      withSession: (work) => work(db),
      delivery: {
        readReceipt: vi.fn().mockResolvedValue(null),
        send: vi.fn().mockRejectedValue(sendError),
      },
      bind: vi.fn().mockResolvedValue({
        recipientReference: "cli-1",
        templateReference: "subscription-created",
      }),
      onError,
    });

    const summary = await runner.run(10);
    expect(summary.failed).toBe(1);
    const sourcesQuery = queries.find((q) => q.text.includes("WITH sources AS"));
    expect(sourcesQuery).toBeDefined();
    expect(sourcesQuery!.text).toContain("COALESCE(r.attempt_count,0)<$3::integer");
    expect(sourcesQuery!.values?.[2]).toBe(3);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      { source: "event", id: "evt-1", subscriptionId: "sub-1" },
      sendError,
    );
    expect(unlocked).toHaveLength(1);
  });
});
