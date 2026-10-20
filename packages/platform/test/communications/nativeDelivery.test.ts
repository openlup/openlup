import { expect, it } from "vitest";
import { createPostgresDeliveryReconciliationPort } from "../../src/communications/postgresDeliveryReconciliation.js";
import { runDeliveryReconciliation } from "../../src/communications/deliveryReconciliation.js";

it("separates failed reads, fairness attempts and first-only abandonment", async () => {
  const effects: string[] = [];
  const result = await runDeliveryReconciliation({
    port: { findFrozenSends: async () => [404, 401, 0, 500].map(id => ({ id: String(id), messageId: String(id) })),
      recordPollAttempt: async ({ sendId }) => { effects.push(`attempt:${sendId}`); },
      recordSendNotFound: async ({ sendId, threshold }) => { effects.push(`missing:${sendId}:${threshold}`); return { abandoned: true }; },
      applyPolledEvent: async () => { effects.push("delivered"); } },
    readEmail: async id => ({ ok: false, httpStatus: Number(id), recipientEmail: null }),
    observationFor: () => null, now: "2026-10-19T12:00:00Z", graceMinutes: 10, limit: 10,
  });
  expect(effects).toEqual(["missing:404:3", "attempt:401", "attempt:0", "attempt:500"]);
  expect(result).toMatchObject({ abandoned: 1, reconciled: 0, failures: 4 });
});
it("refuses missing configuration and captured registration before database access", async () => {
  expect(() => createPostgresDeliveryReconciliationPort({ connectionString: "" }, { binding: "probe" })).toThrow();
  const store = createPostgresDeliveryReconciliationPort({ connectionString: "postgresql://unused.invalid/synthetic" }, { binding: "probe" });
  await expect(store.registerNetworkTarget({ sourceKey: "capture", messageId: "captured:1", recipientEmail: "recipient@example.invalid", templateReference: "probe", acceptedAt: "2026-10-19T12:00:00Z", evidence: "capture" } as never)).rejects.toThrow();
  await store.close();
});
