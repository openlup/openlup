import { describe, expect, it, vi } from "vitest";
import {
  createCustomerDeliveryAlignmentRowsReader,
  createDeliveryAlignmentAdmissionClient,
  readOpenDeliveryAlignmentCases,
} from "./subscriptionDeliveryAlignmentGateway.js";

function queryResult(data: unknown[], error: { message: string } | null = null) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "in", "order", "limit"] as const) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  query.then = (resolve: (value: unknown) => unknown) => resolve({ data, error });
  return query;
}

describe("subscription delivery alignment gateway", () => {
  it("maps renewal admission to the authoritative RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, state: "none", reason: "no_delay_evidence" },
      error: null,
    });
    const client = createDeliveryAlignmentAdmissionClient({ rpc });

    await expect(client.admitDeliveryAlignment({
      subscriptionId: "sub-1",
      scheduledAt: "2026-08-10T00:00:00Z",
      asOf: "2026-08-10T00:01:00Z",
    })).resolves.toEqual({ allowed: true, state: "none", reason: "no_delay_evidence" });
    expect(rpc).toHaveBeenCalledWith("subscription_delivery_alignment_admit_renewal", {
      p_subscription_id: "sub-1",
      p_scheduled_at: "2026-08-10T00:00:00Z",
      p_as_of: "2026-08-10T00:01:00Z",
    });
  });

  it("reads only customer-visible alignment states", async () => {
    const query = queryResult([{ subscription_id: "sub-1", state: "protected" }]);
    const from = vi.fn().mockReturnValue(query);

    await expect(createCustomerDeliveryAlignmentRowsReader({ from })(["sub-1"]))
      .resolves.toEqual([{ subscription_id: "sub-1", state: "protected" }]);
    expect(from).toHaveBeenCalledWith("subscription_delivery_alignment_cases");
    expect(query.in).toHaveBeenCalledWith("state", ["protected", "aligned"]);
  });

  it("reads only open operator evidence and propagates query errors", async () => {
    const openQuery = queryResult([{ subscription_id: "sub-1", state: "manual_review" }]);
    await expect(readOpenDeliveryAlignmentCases({ from: vi.fn().mockReturnValue(openQuery) }))
      .resolves.toEqual([{ subscription_id: "sub-1", state: "manual_review" }]);
    expect(openQuery.in).toHaveBeenCalledWith("state", ["protected", "manual_review"]);

    const failedQuery = queryResult([], { message: "read failed" });
    await expect(readOpenDeliveryAlignmentCases({ from: vi.fn().mockReturnValue(failedQuery) }))
      .rejects.toEqual({ message: "read failed" });
  });
});
