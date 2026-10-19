import { CommunicationConflictError } from "./errors.js";
import type { PgQueryExecutor, PostgresDataGatewayEnv, PostgresDataGatewayOptions } from "../data/index.js";
import type { NativeNotificationRecipient, NativeNotificationType } from "./nativeOperations.js";
import { nativeEmail, nativeStamp, nativeText, nativeTransactions } from "./postgresNativeOperations.js";
const types: NativeNotificationType[] = ["packaging_digest","new_signup","commerce_payment_critical"];
function notificationType(value: NativeNotificationType): NativeNotificationType {
  if (!types.includes(value)) throw new Error("native_notification_type_invalid");
  return value;
}
export interface NativeNotificationRecipientsOptions extends PostgresDataGatewayOptions { /** Verified host operator principal, never request body data. */ operatorId: string }
export interface NativeNotificationRecipientsPort {
  listNotificationRecipients(input: { notification_type: NativeNotificationType }): Promise<{ recipients: NativeNotificationRecipient[] }>;
  createNotificationRecipient(input: { email: string; name: string | null; notification_type: NativeNotificationType; active: true }): Promise<{ created: true; email: string; notification_type: NativeNotificationType }>;
  updateNotificationRecipient(input: { recipientId: string; active: boolean }): Promise<{ updated: true; recipientId: string }>;
  deleteNotificationRecipient(input: { recipientId: string }): Promise<{ deleted: true; recipientId: string }>;
  close(): Promise<void>;
}
export function createPostgresNotificationRecipientsPort(env: PostgresDataGatewayEnv, options: NativeNotificationRecipientsOptions): NativeNotificationRecipientsPort {
  const operator = nativeText(options.operatorId);
  const lane = nativeTransactions(env, options, ["public.notification_recipients","public.platform_communication_operators","public.platform_human_memberships","public.platform_control_operators"]);
  const run = <T>(work: (db: PgQueryExecutor) => Promise<T>) => lane.run(async db => {
    // Match the reference communications control-plane admission, retaining row locks through commit.
    const allowed = (await db.query(`SELECT o.principal_id FROM public.platform_communication_operators o
      JOIN public.platform_human_memberships m ON m.principal_id=o.principal_id
      WHERE o.principal_id=$1 AND o.active AND m.membership_state='active' AND m.role IN ('admin','distributor')
      AND NOT EXISTS (SELECT 1 FROM public.platform_control_operators c WHERE c.principal_id=o.principal_id) FOR SHARE OF o,m`, [operator])).rows;
    if (allowed.length !== 1) throw new Error("communications_operator_required");
    return work(db);
  });
  return {
    close: lane.close,
    listNotificationRecipients(input) {
      const type = notificationType(input.notification_type);
      return run(async db => ({ recipients: (await db.query("SELECT id,email,name,active,notification_type,created_at FROM public.notification_recipients WHERE notification_type=$1 ORDER BY created_at,id", [type])).rows.map(row => {
        if (typeof row.active !== "boolean" || (row.name !== null && typeof row.name !== "string")) throw new Error("native_notification_row_invalid");
        return { id: nativeText(row.id),email: nativeEmail(row.email),name: row.name as string | null,active: row.active,notification_type: notificationType(row.notification_type as NativeNotificationType),created_at: nativeStamp(row.created_at) };
      }) }));
    },
    async createNotificationRecipient(input) {
      const email = nativeEmail(input.email), type = notificationType(input.notification_type);
      if (input.active !== true || (input.name !== null && typeof input.name !== "string")) throw new Error("native_notification_request_invalid");
      const name = input.name === null ? null : input.name.trim();
      if (name !== null && name.length > 256) throw new Error("native_notification_request_invalid");
      try { return await run(async db => {
        await db.query("INSERT INTO public.notification_recipients (email,name,notification_type,active) VALUES ($1,$2,$3,true)", [email,name,type]);
        return { created: true as const,email,notification_type: type };
      }); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "23505") throw new CommunicationConflictError("notification_recipient_conflict"); throw error; }
    },
    async updateNotificationRecipient(input) {
      if (typeof input.active !== "boolean" || Object.keys(input).some(key => !["active","recipientId"].includes(key))) throw new Error("native_notification_request_invalid");
      return run(async db => { await db.query("UPDATE public.notification_recipients SET active=$2,updated_at=clock_timestamp() WHERE id=$1", [input.recipientId,input.active]); return { updated: true as const,recipientId: input.recipientId }; });
    },
    deleteNotificationRecipient(input) {
      return run(async db => { await db.query("DELETE FROM public.notification_recipients WHERE id=$1", [input.recipientId]); return { deleted: true as const,recipientId: input.recipientId }; });
    },
  };
}
