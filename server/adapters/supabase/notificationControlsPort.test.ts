import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupabaseNotificationControlsPort,
  readMandatoryNotificationControlReadiness,
  type NotificationControlsSupabaseClient,
} from "./notificationControlsPort.js";
import { MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS } from "../../domains/communications/emailNotificationControlReadiness.js";

describe("createSupabaseNotificationControlsPort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T03:04:05.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the complete control projection in provider order with fail-open enabled semantics", async () => {
    const { client, calls } = createClient([{
      data: [
        { slug: "disabled", enabled: false },
        { slug: "enabled", enabled: true },
        { slug: 42, enabled: null },
        { slug: "missing-enabled" },
      ],
      error: null,
    }]);

    await expect(createSupabaseNotificationControlsPort(client).listControls()).resolves.toEqual([
      { slug: "disabled", enabled: false },
      { slug: "enabled", enabled: true },
      { slug: "42", enabled: true },
      { slug: "missing-enabled", enabled: true },
    ]);
    expect(calls).toEqual([{
      table: "comms_notification_controls",
      operations: [["select", "slug, enabled"]],
    }]);
  });

  it("upserts a family key with the exact conflict target, timestamp, and acknowledgement", async () => {
    const { client, calls } = createClient([{ data: null, error: null }]);

    await expect(
      createSupabaseNotificationControlsPort(client).setControl("auth-*", false),
    ).resolves.toEqual({ updated: true, slug: "auth-*", enabled: false });
    expect(calls).toEqual([{
      table: "comms_notification_controls",
      operations: [[
        "upsert",
        { slug: "auth-*", enabled: false, updated_at: "2026-07-02T03:04:05.000Z" },
        { onConflict: "slug" },
      ]],
    }]);
  });

  it("preserves upstream errors and stable fallbacks for reads and writes", async () => {
    const { client } = createClient([
      { data: null, error: { message: "read denied" } },
      { data: null, error: {} },
    ]);
    const port = createSupabaseNotificationControlsPort(client);

    await expect(port.listControls()).rejects.toThrow("read denied");
    await expect(port.setControl("commerce-order-paid", true)).rejects.toThrow(
      "notification_control_update_failed",
    );
  });

  it("reads mandatory readiness through the exact projection and retains fail-open missing-row semantics", async () => {
    const seen: { table?: string; columns?: string; column?: string; values?: readonly string[] } = {};
    const readiness = await readMandatoryNotificationControlReadiness({
      from: (table) => {
        seen.table = table;
        return {
          select: (columns) => {
            seen.columns = columns;
            return {
              in: (column, values) => {
                seen.column = column;
                seen.values = values;
                return Promise.resolve({
                  data: [
                    { slug: "subscription-welcome", enabled: false },
                    { slug: null, enabled: false },
                    { slug: "commerce-order-paid", enabled: false },
                    { slug: "ignored-non-boolean", enabled: null },
                    { slug: "subscription-welcome", enabled: true },
                  ],
                  error: null,
                });
              },
            };
          },
        };
      },
    });

    expect(seen).toEqual({
      table: "comms_notification_controls",
      columns: "slug,enabled",
      column: "slug",
      values: MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS,
    });
    expect(readiness).toEqual({
      requiredControlCount: MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS.length,
      disabledControlKeys: ["commerce-order-paid", "subscription-welcome"],
    });
  });

  it("fails mandatory readiness closed with provider message or code", async () => {
    await expect(readMandatoryNotificationControlReadiness({
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: null, error: { message: "denied" } }),
        }),
      }),
    })).rejects.toThrow("notification_control_read_failed: denied");

    await expect(readMandatoryNotificationControlReadiness({
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: null, error: { code: "42501" } }),
        }),
      }),
    })).rejects.toThrow("notification_control_read_failed: 42501");
  });
});

type Result = { data: unknown[] | null; error: { message?: string } | null };
type Call = { table: string; operations: unknown[][] };

function createClient(results: Result[]) {
  const calls: Call[] = [];
  const client: NotificationControlsSupabaseClient = {
    from(table) {
      const call: Call = { table, operations: [] };
      calls.push(call);
      const query = {
        select(...args: unknown[]) { call.operations.push(["select", ...args]); return query; },
        upsert(...args: unknown[]) { call.operations.push(["upsert", ...args]); return query; },
        then<TResult1 = Result, TResult2 = never>(
          resolve?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(results.shift() ?? { data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { client, calls };
}
