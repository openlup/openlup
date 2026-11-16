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

it("reads adopter cadences above 120 and refuses non-integer or unrepresentable cadence data", async () => {
  const subscription = { subscriptionId: "11111111-1111-4111-8111-111111111111", status: "active", cadenceDays: 180,
    nextCycleAt: "2027-05-01T00:00:00Z", editCutoffAt: null, templateVersion: 1, recurringTotal: null, lines: [] };
  const port = createPostgresCustomerSubscriptionSnapshotPort({ rpc: async () => ({ error: null,
    data: { contractVersion: "customer.subscription_control.v1", subscriptions: [subscription] } }) });
  expect((await port.getSnapshot())?.subscriptions[0].cadenceDays).toBe(180);
  for (const days of [0, 1.5, 2_147_483_648]) { subscription.cadenceDays = days; await expect(port.getSnapshot()).rejects.toThrow(); }
});
