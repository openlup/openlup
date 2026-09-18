import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseAdminCommunicationsGateway,
  createSupabaseCommunicationsActorGateway,
} from "./communicationsGateway.js";

describe("managed communications Supabase gateway", () => {
  it("memoizes one admin service-role client and injects it into the email-sends adapter", async () => {
    const calls: Array<{ table: string; operations: unknown[][] }> = [];
    const client = queryClient(calls, () => ({
      data: [{ id: "event-1", send_id: "send-1", event_type: "open", timestamp: null }],
      error: null,
    }));
    const clientFactory = vi.fn(() => client);
    const gateway = createSupabaseAdminCommunicationsGateway(env(), { clientFactory });

    await expect(
      gateway.emailSendsReadPort().getAdminEmailSendEvents({ sendId: "send-1" }),
    ).resolves.toEqual({
      events: [{ id: "event-1", send_id: "send-1", event_type: "open", timestamp: null }],
    });
    expect(gateway.permissionsPort().readByEmail).toBeTypeOf("function");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith(env());
    expect(calls).toEqual([{
      table: "email_events",
      operations: [
        ["select", "*"],
        ["eq", "send_id", "send-1"],
        ["order", "timestamp", { ascending: true }],
      ],
    }]);
  });

  it("composes actor adapters from exactly the caller-provided client", async () => {
    const calls: Array<{ table: string; operations: unknown[][] }> = [];
    const client = queryClient(calls, (table, operations) => {
      const selected = operations.find(([operation]) => operation === "select")?.[1];
      if (table === "email_templates" && selected === "slug, name, sequence_order") {
        return { data: [{ slug: "welcome", name: "Welcome", sequence_order: null }], error: null };
      }
      if (table === "email_templates") {
        return {
          data: [{
            id: "template-1",
            active: null,
            body_html: null,
            body_text: "Text",
            name: "Welcome",
            sequence_order: 1,
            slug: "welcome",
            subject: "Welcome",
            trigger_type: null,
          }],
          error: null,
        };
      }
      if (table === "comms_notification_controls") {
        return { data: [{ slug: "auth-*", enabled: false }], error: null };
      }
      if (table === "email_sends") {
        return {
          data: [{ id: "send-1", template_slug: "welcome", status: "sent", sent_at: null }],
          error: null,
        };
      }
      return {
        data: [{ send_id: "send-1", event_type: "open", link_url: null, timestamp: null }],
        error: null,
      };
    });
    const gateway = createSupabaseCommunicationsActorGateway(client);
    const activePort = gateway.activeTemplatesReadPort();

    await expect(activePort.getTesterEmailSends({ testerId: "tester-no-history" })).resolves.toEqual({ sends: [] });
    expect(calls).toHaveLength(0);
    await expect(activePort.getActiveEmailTemplates()).resolves.toEqual({
      templates: [{ slug: "welcome", name: "Welcome", sequence_order: null }],
    });
    await expect(gateway.notificationControlsPort().listControls()).resolves.toEqual([
      { slug: "auth-*", enabled: false },
    ]);
    await expect(gateway.templatesPort().getAdminEmailTemplates()).resolves.toEqual({
      templates: [expect.objectContaining({ id: "template-1", active: false, body_html: null })],
    });
    await expect(
      gateway.testerDetailReadPort().getTesterEmailSends({ testerId: "tester-1" }),
    ).resolves.toEqual({
      sends: [{
        id: "send-1",
        template_slug: "welcome",
        status: "sent",
        sent_at: null,
        events: [{ send_id: "send-1", event_type: "open", link_url: null, timestamp: null }],
      }],
    });
    expect(gateway.notificationRecipientsPort().listNotificationRecipients).toBeTypeOf("function");

    expect(calls.map((call) => [call.table, call.operations[0]])).toEqual([
      ["email_templates", ["select", "slug, name, sequence_order"]],
      ["comms_notification_controls", ["select", "slug, enabled"]],
      ["email_templates", ["select", "id, active, body_html, body_text, name, sequence_order, slug, subject, trigger_type"]],
      ["email_sends", ["select", "id, template_slug, status, sent_at"]],
      ["email_events", ["select", "send_id, event_type, link_url, timestamp"]],
    ]);
  });
});

type QueryResult = { data: unknown[] | null; error: { message?: string } | null };

function queryClient(
  calls: Array<{ table: string; operations: unknown[][] }>,
  result: (table: string, operations: unknown[][]) => QueryResult,
) {
  return {
    from(table: string) {
      const call = { table, operations: [] as unknown[][] };
      calls.push(call);
      const query = {
        select(...args: unknown[]) { call.operations.push(["select", ...args]); return query; },
        eq(...args: unknown[]) { call.operations.push(["eq", ...args]); return query; },
        in(...args: unknown[]) { call.operations.push(["in", ...args]); return query; },
        order(...args: unknown[]) { call.operations.push(["order", ...args]); return query; },
        then<TResult1 = QueryResult, TResult2 = never>(
          resolve?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(result(table, call.operations)).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function env() {
  return { url: "https://example.supabase.co", serviceRoleKey: "service" };
}
