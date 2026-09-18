import {
  MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS,
  type MandatoryNotificationControlReadiness,
} from "../../domains/communications/emailNotificationControlReadiness.js";

export interface NotificationControl {
  slug: string;
  enabled: boolean;
}

export interface NotificationControlsSupabaseClient {
  from(table: "comms_notification_controls"): NotificationControlsQuery;
}

type NotificationControlRow = { slug?: unknown; enabled?: unknown };

interface NotificationControlReadinessQuery {
  in(column: "slug", values: readonly string[]): PromiseLike<{
    data: NotificationControlRow[] | null;
    error: { message?: string; code?: string } | null;
  }>;
}

export interface NotificationControlReadClient {
  from(table: "comms_notification_controls"): {
    select(columns: "slug,enabled"): NotificationControlReadinessQuery;
  };
}

interface NotificationControlsQuery extends PromiseLike<{
  data: unknown[] | null;
  error: { message?: string } | null;
}> {
  select(columns: string): NotificationControlsQuery;
  upsert(values: Record<string, unknown>, options: { onConflict: string }): NotificationControlsQuery;
}

export function createSupabaseNotificationControlsPort(
  client: NotificationControlsSupabaseClient,
) {
  return {
    async listControls(): Promise<NotificationControl[]> {
      const { data, error } = await client
        .from("comms_notification_controls")
        .select("slug, enabled");
      if (error) throw new Error(error.message ?? "notification_controls_query_failed");
      return (Array.isArray(data) ? data : []).map((row) => ({
        slug: String((row as { slug: unknown }).slug),
        enabled: (row as { enabled?: unknown }).enabled !== false,
      }));
    },

    async setControl(slug: string, enabled: boolean): Promise<{ updated: true; slug: string; enabled: boolean }> {
      const { error } = await client
        .from("comms_notification_controls")
        .upsert({ slug, enabled, updated_at: new Date().toISOString() }, { onConflict: "slug" });
      if (error) throw new Error(error.message ?? "notification_control_update_failed");
      return { updated: true, slug, enabled };
    },
  };
}

export async function readMandatoryNotificationControlReadiness(
  client: NotificationControlReadClient,
): Promise<MandatoryNotificationControlReadiness> {
  const { data, error } = await client
    .from("comms_notification_controls")
    .select("slug,enabled")
    .in("slug", MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS);

  if (error) {
    throw new Error(`notification_control_read_failed: ${error.message ?? error.code ?? "unknown"}`);
  }

  const disabledControlKeys = (data ?? [])
    .filter((row) => typeof row.slug === "string" && row.enabled === false)
    .map((row) => row.slug as string)
    .sort();

  return {
    requiredControlCount: MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS.length,
    disabledControlKeys,
  };
}
