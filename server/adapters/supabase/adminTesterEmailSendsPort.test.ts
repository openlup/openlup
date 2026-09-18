import { describe, expect, it } from "vitest";
import {
  createSupabaseAdminTesterEmailSendsPort,
  type AdminTesterEmailSendsSupabaseClient,
} from "./adminTesterEmailSendsPort.js";

describe("createSupabaseAdminTesterEmailSendsPort", () => {
  it("reads sends newest-first, events oldest-first, and preserves send/event nulls and ordering", async () => {
    const { client, calls } = createClient({
      email_sends: [{
        data: [
          { id: "send-2", template_slug: null, status: "queued", sent_at: null },
          { id: "send-1", template_slug: "welcome", status: "sent", sent_at: "2026-05-01" },
        ],
        error: null,
      }],
      email_events: [{
        data: [
          { send_id: "send-1", event_type: "open", link_url: null, timestamp: "2026-05-02" },
          { send_id: "send-1", event_type: "click", link_url: "https://example.test", timestamp: "2026-05-03" },
          { send_id: "send-2", event_type: "queued", link_url: null, timestamp: null },
        ],
        error: null,
      }],
    });

    await expect(
      createSupabaseAdminTesterEmailSendsPort(client).getTesterEmailSends({ testerId: "tester-1" }),
    ).resolves.toEqual({
      sends: [
        {
          id: "send-2",
          template_slug: null,
          status: "queued",
          sent_at: null,
          events: [{ send_id: "send-2", event_type: "queued", link_url: null, timestamp: null }],
        },
        {
          id: "send-1",
          template_slug: "welcome",
          status: "sent",
          sent_at: "2026-05-01",
          events: [
            { send_id: "send-1", event_type: "open", link_url: null, timestamp: "2026-05-02" },
            { send_id: "send-1", event_type: "click", link_url: "https://example.test", timestamp: "2026-05-03" },
          ],
        },
      ],
    });
    expect(calls).toEqual([
      {
        table: "email_sends",
        operations: [
          ["select", "id, template_slug, status, sent_at"],
          ["eq", "tester_id", "tester-1"],
          ["order", "sent_at", { ascending: false }],
        ],
      },
      {
        table: "email_events",
        operations: [
          ["select", "send_id, event_type, link_url, timestamp"],
          ["in", "send_id", ["send-2", "send-1"]],
          ["order", "timestamp", { ascending: true }],
        ],
      },
    ]);
  });

  it("does not query events when send history is empty", async () => {
    const { client, calls } = createClient({
      email_sends: [{ data: null, error: null }],
      email_events: [],
    });

    await expect(
      createSupabaseAdminTesterEmailSendsPort(client).getTesterEmailSends({ testerId: "tester-empty" }),
    ).resolves.toEqual({ sends: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe("email_sends");
  });

  it("fails the send read but deliberately degrades an event read failure to empty events", async () => {
    const failedSend = createClient({
      email_sends: [{ data: null, error: {} }],
      email_events: [],
    });
    await expect(
      createSupabaseAdminTesterEmailSendsPort(failedSend.client).getTesterEmailSends({ testerId: "tester-1" }),
    ).rejects.toThrow("tester_email_sends_query_failed");

    const failedEvents = createClient({
      email_sends: [{
        data: [{ id: "send-1", template_slug: "welcome", status: "sent", sent_at: null }],
        error: null,
      }],
      email_events: [{ data: null, error: { message: "events denied" } }],
    });
    await expect(
      createSupabaseAdminTesterEmailSendsPort(failedEvents.client).getTesterEmailSends({ testerId: "tester-1" }),
    ).resolves.toEqual({
      sends: [{ id: "send-1", template_slug: "welcome", status: "sent", sent_at: null, events: [] }],
    });
  });
});

type Result = { data: unknown[] | null; error: { message?: string } | null };
type Table = "email_sends" | "email_events";
type Call = { table: Table; operations: unknown[][] };

function createClient(results: Record<Table, Result[]>) {
  const calls: Call[] = [];
  const client: AdminTesterEmailSendsSupabaseClient = {
    from(table) {
      const call: Call = { table, operations: [] };
      calls.push(call);
      const query = {
        select(...args: unknown[]) { call.operations.push(["select", ...args]); return query; },
        eq(...args: unknown[]) { call.operations.push(["eq", ...args]); return query; },
        in(...args: unknown[]) { call.operations.push(["in", ...args]); return query; },
        order(...args: unknown[]) { call.operations.push(["order", ...args]); return query; },
        then<TResult1 = Result, TResult2 = never>(
          resolve?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(results[table].shift() ?? { data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { client, calls };
}
