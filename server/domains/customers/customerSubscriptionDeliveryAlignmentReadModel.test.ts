import { describe, expect, it } from "vitest";
import { mapCurrentDeliveryAlignments } from "./customerSubscriptionDeliveryAlignmentReadModel.js";
import {
  createCustomerDeliveryAlignmentRowsReader,
  createDeliveryAlignmentAdmissionClient,
  readOpenDeliveryAlignmentCases,
} from "../../adapters/subscriptionDeliveryAlignmentGateway.js";

describe("mapCurrentDeliveryAlignments", () => {
  const schedules = new Map([
    ["protected-sub", "2026-09-01T10:00:00.000Z"],
    ["aligned-sub", "2026-09-20T10:00:00.000Z"],
    ["advanced-sub", "2026-10-18T10:00:00.000Z"],
  ]);

  it("projects protected and only the aligned case for the authoritative next schedule", () => {
    const result = mapCurrentDeliveryAlignments([
      { subscription_id: "protected-sub", state: "protected", aligned_next_cycle_at: null },
      { subscription_id: "aligned-sub", state: "aligned", aligned_next_cycle_at: "2026-09-20T12:00:00+02:00" },
      { subscription_id: "advanced-sub", state: "aligned", aligned_next_cycle_at: "2026-09-20T10:00:00.000Z" },
    ], schedules);

    expect([...result.entries()]).toEqual([
      ["protected-sub", { state: "protected" }],
      ["aligned-sub", { state: "aligned" }],
    ]);
  });

  it("omits internal states and does not let an older case mask a newer current case", () => {
    const result = mapCurrentDeliveryAlignments([
      { subscription_id: "protected-sub", state: "manual_review", aligned_next_cycle_at: null },
      { subscription_id: "protected-sub", state: "protected", aligned_next_cycle_at: null },
      { subscription_id: "aligned-sub", state: "shadow", aligned_next_cycle_at: null },
    ], schedules);

    expect(result.get("protected-sub")).toEqual({ state: "protected" });
    expect(result.has("aligned-sub")).toBe(false);
  });

  // The banner is a positive allowlist, not a denylist. A ledger state this
  // mapper has never heard of - the shape any future terminal case closure takes
  // - must therefore render nothing at all, without the mapper being taught the
  // name. Pinned because the alternative failure is silent: an unmapped state
  // that leaked through would tell a customer their delivery is still protected
  // when the case is over.
  it("renders no banner for a ledger state it does not recognise", () => {
    const result = mapCurrentDeliveryAlignments([
      { subscription_id: "protected-sub", state: "closed_undeliverable", aligned_next_cycle_at: null },
      { subscription_id: "aligned-sub", state: "released", aligned_next_cycle_at: "2026-09-20T10:00:00.000Z" },
    ], schedules);

    expect([...result.entries()]).toEqual([]);
  });
});

describe("subscription delivery-alignment database adapter", () => {
  it("pins the customer-safe case query and admission RPC arguments", async () => {
    const { client, calls } = fakeDatabaseClient({
      subscription_delivery_alignment_cases: [
        { subscription_id: "sub-1", state: "protected", aligned_next_cycle_at: null },
      ],
    });
    const rows = await createCustomerDeliveryAlignmentRowsReader(client)(["sub-1"]);
    const admission = await createDeliveryAlignmentAdmissionClient(client).admitDeliveryAlignment({
      subscriptionId: "sub-1",
      scheduledAt: "2026-09-01T10:00:00.000Z",
      asOf: "2026-09-01T10:01:00.000Z",
    });

    expect(rows).toEqual([{ subscription_id: "sub-1", state: "protected", aligned_next_cycle_at: null }]);
    expect(admission).toEqual({ allowed: true, state: "none", reason: "on_time" });
    expect(calls).toContainEqual(["in", "subscription_id", ["sub-1"]]);
    expect(calls).toContainEqual(["in", "state", ["protected", "aligned"]]);
    expect(calls).toContainEqual(["rpc", "subscription_delivery_alignment_admit_renewal", {
      p_subscription_id: "sub-1",
      p_scheduled_at: "2026-09-01T10:00:00.000Z",
      p_as_of: "2026-09-01T10:01:00.000Z",
    }]);
  });

  it("keeps internal open-case evidence in the operations adapter", async () => {
    const evidence = [{
      subscription_id: "sub-2",
      state: "manual_review",
      observed_next_cycle_at: "2026-09-01T10:00:00.000Z",
    }];
    const { client, calls } = fakeDatabaseClient({ subscription_delivery_alignment_cases: evidence });

    await expect(readOpenDeliveryAlignmentCases(client)).resolves.toEqual(evidence);
    expect(calls).toContainEqual(["select", "subscription_delivery_alignment_cases", "subscription_id,state,observed_next_cycle_at"]);
    expect(calls).toContainEqual(["in", "state", ["protected", "manual_review"]]);
    expect(calls).toContainEqual(["limit", 2000]);
  });
});

function fakeDatabaseClient(rows: Record<string, unknown[]>) {
  const calls: unknown[][] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          calls.push(["select", table, columns]);
          const query = {
            in(column: string, values: readonly string[]) {
              calls.push(["in", column, values]);
              return query;
            },
            order(column: string, options: unknown) {
              calls.push(["order", column, options]);
              return query;
            },
            limit(count: number) {
              calls.push(["limit", count]);
              return query;
            },
            then(resolve: (value: unknown) => unknown) {
              return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
            },
          };
          return query;
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(["rpc", name, args]);
      return Promise.resolve({ data: { allowed: true, state: "none", reason: "on_time" }, error: null });
    },
  };
  return { client, calls };
}
