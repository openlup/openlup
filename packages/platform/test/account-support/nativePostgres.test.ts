import { expect, it, vi } from "vitest";
import { createPostgresCustomerSupportJourneyPort } from "@openlup/platform/account-support/postgres";
import { OperatorSubscriptionAuthorityUnavailableError } from "@openlup/platform/account-support";

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
