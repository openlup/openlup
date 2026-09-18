import { describe, expect, it } from "vitest";
import { readEmailHealthMetrics } from "./adminEmailSendsDeliveryEvidence.js";

function fakeClient(countsByKey: Record<string, number>) {
  const calls: Array<{
    table: string;
    select: [string, { count: string; head: boolean }];
    filters: unknown[][];
  }> = [];
  const client = {
    from(table: string) {
      expect(table).toBe("communication_email_deliveries");
      const state: { single?: string; statuses?: string[]; lt?: string; gte?: string } = {};
      const call = { table, select: ["", { count: "", head: false }] as [string, { count: string; head: boolean }], filters: [] as unknown[][] };
      const q = {
        in(col: string, vals: readonly string[]) {
          call.filters.push(["in", col, [...vals]]);
          if (col === "status") state.statuses = [...vals];
          return q;
        },
        eq(col: string, val: string) {
          call.filters.push(["eq", col, val]);
          if (col === "status") state.single = val;
          return q;
        },
        gte(col: string, val: string) {
          call.filters.push(["gte", col, val]);
          state.gte = col;
          return q;
        },
        lt(col: string, val: string) {
          call.filters.push(["lt", col, val]);
          state.lt = col;
          return q;
        },
        then(resolve: (v: { count: number; error: null }) => unknown) {
          expect(state.gte === "created_at" || Boolean(state.lt)).toBe(true);
          const key = state.single
            ? `eq:${state.single}${state.lt ? `:${state.lt}` : ""}`
            : `in:${(state.statuses ?? []).join(",")}`;
          return Promise.resolve({ count: countsByKey[key] ?? 0, error: null }).then(resolve);
        },
      };
      return { select: (columns: string, options: { count: string; head: boolean }) => {
        call.select = [columns, options];
        calls.push(call);
        return q;
      } };
    },
  } as never;
  return { client, calls };
}

describe("readEmailHealthMetrics", () => {
  it("aggregates attempted, sent, failed, delayed, and stuck counts", async () => {
    const fake = fakeClient({
      "in:sent,delivered,delivery_delayed,failed,bounced,complained,missed": 12,
      "in:sent,delivered": 8,
      "in:failed,bounced,complained,missed": 3,
      "eq:delivery_delayed": 1,
      "eq:failed": 1,
      "eq:processing:updated_at": 2,
      "in:planned,queued": 4,
    });
    const metrics = await readEmailHealthMetrics(
      fake.client,
      { windowStartIso: "2026-06-26T08:00:00.000Z", stuckBeforeIso: "2026-06-26T08:30:00.000Z" },
    );

    expect(metrics).toEqual({
      attempted: 12,
      sent: 8,
      failed: 3,
      delayed: 1,
      permanentFailures: 1,
      stuckProcessing: 2,
      stuckScheduled: 4,
    });
    expect(fake.calls).toEqual([
      healthCall([
        ["gte", "created_at", "2026-06-26T08:00:00.000Z"],
        ["in", "status", ["sent", "delivered", "delivery_delayed", "failed", "bounced", "complained", "missed"]],
      ]),
      healthCall([
        ["gte", "created_at", "2026-06-26T08:00:00.000Z"],
        ["in", "status", ["sent", "delivered"]],
      ]),
      healthCall([
        ["gte", "created_at", "2026-06-26T08:00:00.000Z"],
        ["in", "status", ["failed", "bounced", "complained", "missed"]],
      ]),
      healthCall([
        ["gte", "created_at", "2026-06-26T08:00:00.000Z"],
        ["eq", "status", "delivery_delayed"],
      ]),
      healthCall([
        ["gte", "created_at", "2026-06-26T08:00:00.000Z"],
        ["eq", "status", "failed"],
      ]),
      healthCall([
        ["eq", "status", "processing"],
        ["lt", "updated_at", "2026-06-26T08:30:00.000Z"],
      ]),
      healthCall([
        ["in", "status", ["planned", "queued"]],
        ["lt", "expected_send_at", "2026-06-26T08:30:00.000Z"],
      ]),
    ]);
  });

  it("maps null provider counts to zero", async () => {
    const client = {
      from() {
        const q = {
          in: () => q,
          eq: () => q,
          gte: () => q,
          lt: () => q,
          then: (resolve: (v: { count: null; error: null }) => unknown) =>
            Promise.resolve({ count: null, error: null }).then(resolve),
        };
        return { select: () => q };
      },
    } as never;

    await expect(readEmailHealthMetrics(client, {
      windowStartIso: "2026-06-26T08:00:00.000Z",
      stuckBeforeIso: "2026-06-26T08:30:00.000Z",
    })).resolves.toEqual({
      attempted: 0,
      sent: 0,
      failed: 0,
      delayed: 0,
      permanentFailures: 0,
      stuckProcessing: 0,
      stuckScheduled: 0,
    });
  });

  it("throws a stable error when a count query fails", async () => {
    const client = {
      from() {
        const q = {
          in: () => q,
          eq: () => q,
          gte: () => q,
          lt: () => q,
          then: (resolve: (v: { count: null; error: { message: string } }) => unknown) =>
            Promise.resolve({ count: null, error: { message: "boom" } }).then(resolve),
        };
        return {
          select: () => q,
        };
      },
    } as never;

    await expect(
      readEmailHealthMetrics(client, {
        windowStartIso: "2026-06-26T08:00:00.000Z",
        stuckBeforeIso: "2026-06-26T08:30:00.000Z",
      }),
    ).rejects.toThrow("email_health_metrics_query_failed: boom");
  });
});

function healthCall(filters: unknown[][]) {
  return {
    table: "communication_email_deliveries",
    select: ["id", { count: "exact", head: true }],
    filters,
  };
}
