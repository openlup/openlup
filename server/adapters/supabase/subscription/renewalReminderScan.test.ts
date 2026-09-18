import { describe, expect, it } from "vitest";
import { createSupabaseRenewalReminderScanPort } from "./renewalReminderScan.js";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");
const signal = new AbortController().signal;

function client(result: { data: unknown; error?: { code?: string; message?: string } | null }) {
  const ops: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "gte", "lte", "order"]) {
    builder[fn] = (...args: unknown[]) => { ops.push([fn, ...args]); return builder; };
  }
  builder.limit = (count: number) => {
    ops.push(["limit", count]);
    return Promise.resolve({ data: result.data, error: result.error ?? null });
  };
  return {
    ops,
    port: createSupabaseRenewalReminderScanPort(
      { from: (table: string) => { ops.push(["from", table]); return builder as never; } },
      () => NOW,
    ),
  };
}

describe("renewal reminder scan", () => {
  it("reads the due-soon window off the active subscriptions, oldest cycle first", async () => {
    const { port, ops } = client({ data: [
      { id: "sub-1", client_id: "c-1", next_cycle_at: "2026-08-13T09:00:00.000Z" },
    ] });

    expect(await port.scanDueSoon(3, 5, 100, signal)).toEqual([
      { subscriptionId: "sub-1", clientId: "c-1", nextCycleAt: "2026-08-13T09:00:00.000Z" },
    ]);
    expect(ops).toEqual([
      ["from", "subscriptions"],
      ["select", "id, client_id, next_cycle_at"],
      ["eq", "status", "active"],
      // The window is derived from the INJECTED clock, so the boundary this
      // suite pins is the boundary a run at that instant would read.
      ["gte", "next_cycle_at", "2026-08-13T00:00:00.000Z"],
      ["lte", "next_cycle_at", "2026-08-15T00:00:00.000Z"],
      ["order", "next_cycle_at", { ascending: true }],
      ["limit", 100],
    ]);
  });

  it("drops rows missing any of the three fields the reminder needs", async () => {
    const { port } = client({ data: [
      { id: "sub-1", client_id: "c-1", next_cycle_at: "2026-08-13T09:00:00.000Z" },
      { id: "sub-2", client_id: null, next_cycle_at: "2026-08-13T09:00:00.000Z" },
      { id: "sub-3", client_id: "c-3" },
      { client_id: "c-4", next_cycle_at: "2026-08-13T09:00:00.000Z" },
    ] });
    expect(await port.scanDueSoon(3, 5, 100, signal)).toEqual([
      { subscriptionId: "sub-1", clientId: "c-1", nextCycleAt: "2026-08-13T09:00:00.000Z" },
    ]);
  });

  it("answers an empty page when the read returns something that is not a list", async () => {
    const { port } = client({ data: null });
    expect(await port.scanDueSoon(3, 5, 100, signal)).toEqual([]);
  });

  it("fails loudly rather than reporting nothing due", async () => {
    // A silent empty page here is indistinguishable from "no renewals are
    // coming", which is exactly the state that stops every reminder.
    const { port } = client({ data: null, error: { message: "read down" } });
    await expect(port.scanDueSoon(3, 5, 100, signal))
      .rejects.toThrow("renewal_reminder_scan_failed: read down");

    const coded = client({ data: null, error: { code: "57014" } });
    await expect(coded.port.scanDueSoon(3, 5, 100, signal))
      .rejects.toThrow("renewal_reminder_scan_failed: 57014");
  });
});
