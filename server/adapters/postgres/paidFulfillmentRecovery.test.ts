import { describe, expect, it, vi } from "vitest";
import { createPostgresPaidFulfillmentRecoveryOpsPort } from "./paidFulfillmentRecovery.js";

describe("Postgres paid fulfillment recovery", () => {
  it("requeues only the requested discarded event ids", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }] }));
    const port = createPostgresPaidFulfillmentRecoveryOpsPort({ query });
    await expect(port.requeueDiscardedOrderPaidOutboxEvents({
      eventIds: ["11111111-1111-4111-8111-111111111111"],
      requeuedBy: "22222222-2222-4222-8222-222222222222",
      reason: "operator recovery",
    })).resolves.toEqual({ requeuedCount: 1, eventIds: ["11111111-1111-4111-8111-111111111111"] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("outbox_requeue_discarded"), expect.any(Array));
  });
});
