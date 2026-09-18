import type { CommunicationAdminTesterDetailReadPort } from "../../../src/domains/communications/ports.js";
import type { Database } from "../../../src/integrations/supabase/types.js";

type EmailSendRow = Pick<
  Database["public"]["Tables"]["email_sends"]["Row"],
  "id" | "template_slug" | "status" | "sent_at"
>;
type EmailEventRow = Pick<
  Database["public"]["Tables"]["email_events"]["Row"],
  "send_id" | "event_type" | "link_url" | "timestamp"
>;

export interface AdminTesterEmailSendsSupabaseClient {
  from(table: "email_sends" | "email_events"): AdminTesterEmailSendsQuery;
}

interface AdminTesterEmailSendsQuery extends PromiseLike<{
  data: unknown[] | null;
  error: { message?: string } | null;
}> {
  select(columns: string): AdminTesterEmailSendsQuery;
  eq(column: string, value: unknown): AdminTesterEmailSendsQuery;
  in(column: string, values: unknown[]): AdminTesterEmailSendsQuery;
  order(column: string, options?: { ascending?: boolean }): AdminTesterEmailSendsQuery;
}

export function createSupabaseAdminTesterEmailSendsPort(
  client: AdminTesterEmailSendsSupabaseClient,
): Pick<CommunicationAdminTesterDetailReadPort, "getTesterEmailSends"> {
  return {
    async getTesterEmailSends({ testerId }) {
      const { data, error } = await client
        .from("email_sends")
        .select("id, template_slug, status, sent_at")
        .eq("tester_id", testerId)
        .order("sent_at", { ascending: false });
      if (error) throw new Error(error.message ?? "tester_email_sends_query_failed");

      const sends = (data ?? []) as EmailSendRow[];
      const sendIds = sends.map((send) => send.id);
      if (sendIds.length === 0) return { sends: [] };

      const { data: events, error: eventsError } = await client
        .from("email_events")
        .select("send_id, event_type, link_url, timestamp")
        .in("send_id", sendIds)
        .order("timestamp", { ascending: true });

      return {
        sends: attachTesterEmailEvents(sends, eventsError ? [] : ((events ?? []) as EmailEventRow[])),
      };
    },
  };
}

export function attachTesterEmailEvents(
  sends: EmailSendRow[],
  events: EmailEventRow[],
) {
  return sends.map((send) => ({
    ...send,
    events: events.filter((event) => event.send_id === send.id),
  }));
}
