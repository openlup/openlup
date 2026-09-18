import {
  CommunicationConflictError,
  type CommunicationNotificationRecipientsPort,
} from "../../../../src/domains/communications/ports.js";
import type { Database } from "../../../../src/integrations/supabase/types.js";

type RecipientInsert = Database["public"]["Tables"]["notification_recipients"]["Insert"];

export interface NotificationRecipientsSupabaseClient {
  from(table: "notification_recipients"): NotificationRecipientsQuery;
}

interface NotificationRecipientsQuery extends PromiseLike<{
  data: unknown[] | null;
  error: { code?: string; message?: string } | null;
}> {
  select(columns: string): NotificationRecipientsQuery;
  eq(column: string, value: unknown): NotificationRecipientsQuery;
  order(column: string, options?: { ascending?: boolean }): NotificationRecipientsQuery;
  insert(values: RecipientInsert): NotificationRecipientsQuery;
  update(values: Record<string, unknown>): NotificationRecipientsQuery;
  delete(): NotificationRecipientsQuery;
}

export function createSupabaseNotificationRecipientsPort(
  client: NotificationRecipientsSupabaseClient,
): CommunicationNotificationRecipientsPort {
  return {
    async listNotificationRecipients({ notification_type }) {
      const { data, error } = await client
        .from("notification_recipients")
        .select("*")
        .eq("notification_type", notification_type)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message ?? "notification_recipients_query_failed");
      return {
        recipients: (data ?? []).map((recipient) => ({
          ...(recipient as Record<string, unknown>),
          notification_type,
        })) as never,
      };
    },
    async createNotificationRecipient(request) {
      const { error } = await client
        .from("notification_recipients")
        .insert(request as RecipientInsert);
      if (error) {
        if (isDuplicateError(error)) {
          throw new CommunicationConflictError("Ten email już istnieje dla tego typu powiadomień");
        }
        throw new Error(error.message ?? "notification_recipient_create_failed");
      }
      return {
        created: true,
        email: request.email,
        notification_type: request.notification_type,
      };
    },
    async updateNotificationRecipient({ recipientId, active }) {
      const { error } = await client
        .from("notification_recipients")
        .update({ active })
        .eq("id", recipientId);
      if (error) throw new Error(error.message ?? "notification_recipient_update_failed");
      return { updated: true, recipientId };
    },
    async deleteNotificationRecipient({ recipientId }) {
      const { error } = await client
        .from("notification_recipients")
        .delete()
        .eq("id", recipientId);
      if (error) throw new Error(error.message ?? "notification_recipient_delete_failed");
      return { deleted: true, recipientId };
    },
  };
}

function isDuplicateError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
