import { expect, it, vi } from "vitest";
import { createPostgresCustomerSupportJourneyPort } from "@openlup/platform/account-support/postgres";
import { OperatorSubscriptionAuthorityUnavailableError, createPostgresCustomerSubscriptionSnapshotPort } from "@openlup/platform/account-support";

it("keeps unavailable operator contact authority as the public named refusal", async () => {
  const run = vi.fn(), close = vi.fn(async () => {});
  const port = createPostgresCustomerSupportJourneyPort({ connectionString: "postgresql://unused.invalid/example", operatorId: "operator-a" }, {
    createLane: () => ({ run, close }),
  });
  await expect(port.correctSubjectPhone({ subjectId: "subject-a", expectedPhone: "", newPhone: "", idempotencyKey: "phone-a", operatorId: "operator-a" }))
    .rejects.toBeInstanceOf(OperatorSubscriptionAuthorityUnavailableError);
  expect(run).not.toHaveBeenCalled();
  await port.close();
  expect(close).toHaveBeenCalledOnce();
});

it("reads whole-day cadences within the finite date bound", async () => {
  const subscription = { subscriptionId: "11111111-1111-4111-8111-111111111111", status: "active", cadenceDays: 180,
    nextCycleAt: "2027-05-01T00:00:00Z", editCutoffAt: null, templateVersion: 1, recurringTotal: null, lines: [] };
  const port = createPostgresCustomerSubscriptionSnapshotPort({ rpc: async () => ({ error: null,
    data: { contractVersion: "customer.subscription_control.v1", subscriptions: [subscription] } }) });
  for (const days of [1, 180, 3660]) { subscription.cadenceDays = days; expect((await port.getSnapshot())?.subscriptions[0].cadenceDays).toBe(days); }
  for (const days of [0, 1.5, 3661, 2_147_483_647]) { subscription.cadenceDays = days; await expect(port.getSnapshot()).rejects.toThrow(); }
});
