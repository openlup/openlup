import { describe, expect, it, vi } from "vitest";
import { createSupabaseResendDeliveryReconciliationPort } from "./resendDeliveryReconciliation.js";

function fakeClient(tables: {
  email_sends?: Array<Record<string, unknown>>;
  rpcData?: unknown;
  rpcError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const isFilters: Array<{ column: string; value: null }> = [];
  const fromTables: string[] = [];
  const orderCalls: Array<{
    column: string;
    options?: { ascending?: boolean; nullsFirst?: boolean };
  }> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown>; column: string; value: unknown }> = [];
  const client = {
    from(table: string) {
      fromTables.push(table);
      return {
        select: () => ({
          eq: () => ({
            not: () => ({
              is: (column: string, value: null) => {
                isFilters.push({ column, value });
                return {
                  lte: () => ({
                    order: function order(
                      column: string,
                      options?: { ascending?: boolean; nullsFirst?: boolean },
                    ) {
                      orderCalls.push({ column, options });
                      return {
                        order,
                        limit: () => Promise.resolve({ data: tables.email_sends ?? [], error: null }),
                      };
                    },
                  }),
                };
              },
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (column: string, value: unknown) => {
            updates.push({ table, patch, column, value });
            return Promise.resolve({ data: null, error: tables.updateError ?? null });
          },
        }),
      };
    },
    rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return Promise.resolve({ data: tables.rpcData ?? {}, error: tables.rpcError ?? null });
    }),
  };
  return { client, rpcs, isFilters, fromTables, orderCalls, updates };
}

describe("supabase resend delivery reconciliation port", () => {
  it("returns frozen sends without a read-before-write event exclusion", async () => {
    const { client, fromTables, orderCalls } = fakeClient({
      email_sends: [
        { id: "send-1", resend_id: "re-1", status: "sent", sent_at: "2026-07-07T10:00:00Z" },
        { id: "send-2", resend_id: "re-2", status: "sent", sent_at: "2026-07-07T10:05:00Z" },
      ],
    });
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);
    const frozen = await port.findFrozenSends({ now: "2026-07-07T12:00:00.000Z", graceMinutes: 45, limit: 50 });
    expect(frozen).toEqual([
      { id: "send-1", resendId: "re-1", status: "sent" },
      { id: "send-2", resendId: "re-2", status: "sent" },
    ]);
    expect(fromTables).toEqual(["email_sends"]);
    expect(orderCalls).toEqual([
      { column: "poll_last_attempt_at", options: { ascending: true, nullsFirst: true } },
      { column: "sent_at", options: { ascending: true } },
    ]);
  });

  it("excludes abandoned sends from the frozen query", async () => {
    const { client, isFilters } = fakeClient({ email_sends: [] });
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);
    await port.findFrozenSends({ now: "2026-07-07T12:00:00.000Z", graceMinutes: 45, limit: 50 });
    expect(isFilters).toContainEqual({ column: "poll_abandoned_at", value: null });
  });

  it("records a 404 via the abandon RPC and reports the abandoned flag", async () => {
    const { client, rpcs } = fakeClient({ rpcData: true });
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);
    const result = await port.recordSendNotFound({ sendId: "send-1", threshold: 3 });
    expect(result).toEqual({ abandoned: true });
    expect(rpcs[0]).toMatchObject({
      name: "communication_record_email_poll_not_found",
      args: { p_send_id: "send-1", p_threshold: 3 },
    });
  });

  it("reports not-abandoned when the RPC returns false", async () => {
    const { client } = fakeClient({ rpcData: false });
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);
    expect(await port.recordSendNotFound({ sendId: "send-1", threshold: 3 })).toEqual({ abandoned: false });
  });

  it("records a non-404 poll attempt and resets the consecutive not-found count", async () => {
    const { client, updates } = fakeClient({});
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);

    await port.recordPollAttempt({
      sendId: "send-1",
      attemptedAt: "2026-07-07T12:00:00.000Z",
    });

    expect(updates).toEqual([{
      table: "email_sends",
      patch: {
        poll_last_attempt_at: "2026-07-07T12:00:00.000Z",
        poll_not_found_count: 0,
      },
      column: "id",
      value: "send-1",
    }]);
  });

  it("surfaces a failed poll-attempt rotation write", async () => {
    const { client } = fakeClient({ updateError: { message: "db down" } });
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);

    await expect(port.recordPollAttempt({
      sendId: "send-1",
      attemptedAt: "2026-07-07T12:00:00.000Z",
    })).rejects.toThrow("poll_attempt_update: db down");
  });

  it("applies a polled observation through one atomic delivery RPC", async () => {
    const { client, rpcs } = fakeClient({ email_sends: [] });
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);
    await port.applyPolledEvent({
      sendId: "send-1",
      resendId: "re-1",
      webhookType: "email.delivered",
      eventAt: "2026-07-07T12:00:00.000Z",
      recipientEmail: "client@example.com",
    });
    expect(rpcs).toEqual([{
      name: "communication_update_email_delivery_from_provider",
      args: {
        p_email_send_id: "send-1",
        p_provider_message_id: "re-1",
        p_provider_event_type: "email.delivered",
        p_event_at: "2026-07-07T12:00:00.000Z",
        p_metadata: {
          providerEventId: "poll:re-1:email.delivered",
          eventMetadata: {
            source: "resend-delivery-reconciliation",
            resend_id: "re-1",
            email: "client@example.com",
          },
          source: "resend-delivery-reconciliation",
        },
      },
    }]);
  });

  it("surfaces convergence RPC failure so the poller can retry", async () => {
    const { client, rpcs, fromTables } = fakeClient({ rpcError: { message: "db down" } });
    const port = createSupabaseResendDeliveryReconciliationPort(client as never);

    await expect(port.applyPolledEvent({
      sendId: "send-1",
      resendId: "re-1",
      webhookType: "email.delivered",
      eventAt: "2026-07-07T12:00:00.000Z",
      recipientEmail: null,
    })).rejects.toThrow("polled_delivery_rpc: db down");

    expect(rpcs).toHaveLength(1);
    expect(fromTables).toEqual([]);
  });
});
