import { createHash } from "node:crypto";
import { subscriptionLifecycleTemplate } from "./lifecycleMessages.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { completeSystemNotice, reconcileSystemNotices, runAtRiskNotices, runOperatorNotices, systemNoticeIdentity } from "./postgresNoticeExtensions.js";

export interface NativeLifecycleNotice {
  id: string; messageKey: string; source: "dunning" | "event" | "reminder";
  subscriptionId: string; clientId: string; kind: string; templateSlug: string;
  payload: Record<string, unknown>; recoveryUrlPath: string | null;
}
type NoticeCommand = { idempotencyKey: string; recipientReference: string; templateReference: string; accessGrantReference?: string };
type NoticeReceipt = { state: "accepted" | "failed"; deliveryReference: string | null; retryable?: boolean };
export interface NativeLifecycleMessagesOptions {
  /** Neutral safety defaults: 60-second lease, 6 attempts, 900-second backoff. Starter hosts supply explicit configured values. */
  dispatch?: { leaseSeconds?: number; maxAttempts?: number; transientBackoffSeconds?: number };
  /** Neutral safety default: 172800-second recency. Starter hosts supply an explicit configured window. */
  recovered?: { windowSeconds?: number };
  /** Trusted host timing/cap values. Seconds are explicit; day identities remain UTC. */
  notices?: { renewalMinSeconds?: number; renewalMaxSeconds?: number; ordinaryFreshnessSeconds?: number;
    starterFreshnessSeconds?: number; pauseWindowSeconds?: number; atRiskMinDays?: number; atRiskMaxDays?: number;
    atRiskMaxDaysPerCause?: number; operatorLeaseSeconds?: number; operatorMaxAttempts?: number;
    operatorHorizonSeconds?: number; operatorTransientBackoffSeconds?: number };
  /** One exclusive, autocommit connection per callback; never a transaction or shared session. */
  withSession<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** Host composes the transactional delivery engine and durable receipt reader. */
  delivery: {
    send(command: NoticeCommand): Promise<NoticeReceipt>;
    readReceipt(key: string): Promise<NoticeReceipt | null>;
  };
  /** Trusted host rendering/locale/access-link binding. Never accepts browser-supplied recipient facts. */
  bind(notice: NativeLifecycleNotice, recipient: { email: string; firstName: string | null; country: string | null }): Promise<Omit<NoticeCommand, "idempotencyKey">>;
  /** Explicit operator fields only: no customer payload, recovery path or claim token. */
  bindOperator?(notice: { notificationId: string; caseId: string; templateSlug: string }, recipient: { email: string }): Promise<Omit<NoticeCommand, "idempotencyKey">>;
}
const aliases: Record<string, string> = {
  "subscription.activated": "subscription.created",
  "subscription.customer_self_service.pause": "subscription.paused",
  "subscription.customer_self_service.resume": "subscription.resumed",
  "subscription.customer_self_service.cancel": "subscription.cancelled",
  "subscription.customer_self_service.skip_next_cycle": "subscription.cycle_skipped",
  "subscription.customer_self_service.slide_next_cycle": "subscription.delivery_rescheduled",
  "subscription.customer_self_service.change_shipping_address": "subscription.address_changed",
  "subscription.customer_self_service.update_bundle": "subscription.package_changed",
  "subscription.customer_self_service.edit_future_terms": "subscription.package_changed",
  "subscription.customer_self_service.resize_bundle": "subscription.package_changed",
  "subscription.customer_self_service.update_package_template": "subscription.package_changed",
  "subscription.customer_self_service.update_plan_length": "subscription.package_changed",
  "subscription.customer_self_service.add_addon": "subscription.package_changed",
  "subscription.customer_self_service.remove_addon": "subscription.package_changed",
  "subscription.customer_self_service.update_addon_quantity": "subscription.package_changed",
};
/** Policy values use PostgreSQL integer seconds and reject implicit coercion. */
function noticePolicy<T extends Record<string, number>>(input: unknown, defaults: T): T {
  if (input === undefined) return { ...defaults };
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) {
    throw new Error("subscription_notice_options_invalid");
  }
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = (input as Partial<T>)[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error("subscription_notice_options_invalid");
    }
    result[key] = value;
  }
  return result;
}
/** Scheduled trusted-host binding. Existing ledgers own facts; the transactional delivery engine owns delivery receipts.
 * Session advisory locks serialize this binding's sends without a transaction across transport.
 * A transport must preserve command idempotency on ambiguous acceptance; no live-provider claim. */
export function createPostgresLifecycleMessages(options: NativeLifecycleMessagesOptions) {
  const delivery = options.delivery;
  const dispatch = noticePolicy(options.dispatch, { leaseSeconds: 60, maxAttempts: 6, transientBackoffSeconds: 900 });
  const recovered = noticePolicy(options.recovered, { windowSeconds: 172800 });
  const policy = noticePolicy(options.notices, { renewalMinSeconds: 259200, renewalMaxSeconds: 432000,
    ordinaryFreshnessSeconds: 432000, starterFreshnessSeconds: 86400, pauseWindowSeconds: 259200,
    atRiskMinDays: 2, atRiskMaxDays: 5, atRiskMaxDaysPerCause: 2, operatorLeaseSeconds: 300,
    operatorMaxAttempts: 6, operatorHorizonSeconds: 82800, operatorTransientBackoffSeconds: 600 });
  if (policy.renewalMinSeconds > policy.renewalMaxSeconds || policy.atRiskMinDays > policy.atRiskMaxDays) {
    throw new Error("subscription_notice_options_invalid");
  }
  return {
    async run(limit = 25) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("subscription_notice_limit_invalid");
      return options.withSession(async db => {
        const result = { sent: 0, replayed: 0, requeued: 0, failed: 0, skipped: 0, busy: 0, stale: 0 };
        await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue($1::integer,$2::integer,$3::integer,$4::integer,$5::integer)",
          [limit, policy.renewalMinSeconds, policy.renewalMaxSeconds, policy.ordinaryFreshnessSeconds, policy.starterFreshnessSeconds]);
        await db.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch($1::integer,$2::integer)", [limit, policy.pauseWindowSeconds]);
        await reconcileSystemNotices(db);
        await runAtRiskNotices(options, db, limit, policy, result);
        await runOperatorNotices(options, db, limit, policy, result);
        const dunning = (await db.query("SELECT * FROM public.subscription_dunning_claim_batch($1::integer,$2::integer,$3::integer)",
          [limit, dispatch.leaseSeconds, dispatch.maxAttempts])).rows;
        const sources = (await db.query(`WITH sources AS (
          SELECT e.id,'event' AS source,e.subscription_id,s.client_id,e.event_type AS kind,e.payload,false AS outbox
          FROM public.subscription_events e JOIN public.subscriptions s ON s.id=e.subscription_id
          WHERE e.event_type=ANY($2::text[])
          UNION ALL SELECT e.id,'event',e.aggregate_id,s.client_id,e.event_type,e.payload,true
          FROM public.outbox_events e JOIN public.subscriptions s ON s.id=e.aggregate_id
          WHERE e.aggregate_type='subscription_notice' AND e.event_type='subscription.pause_reminder_due'
          UNION ALL SELECT r.id,'reminder',r.subscription_id,s.client_id,
          CASE r.reminder_kind WHEN 'pause_ending' THEN 'subscription.pause_reminder_due' ELSE 'subscription.renewal_upcoming' END,
          jsonb_build_object('reminderDay',r.reminder_day)||CASE WHEN r.renewal_at IS NOT NULL
            THEN jsonb_build_object('renewalAt',to_char(r.renewal_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
            ELSE coalesce(f.payload,'{}'::jsonb) END,false
          FROM public.subscription_reminder_ledger r JOIN public.subscriptions s ON s.id=r.subscription_id
          LEFT JOIN public.subscription_events f ON f.subscription_id=r.subscription_id
            AND f.event_type='subscription.reminder.renewal_facts'
            AND f.idempotency_key='renewal-reminder:'||to_char(r.reminder_day,'YYYY-MM-DD') AND r.reminder_kind='renewal_due_soon'
        ) SELECT x.* FROM sources x LEFT JOIN public.transactional_delivery_receipts r
          ON r.idempotency_key='subscription-notice:'||x.source||':'||x.id::text
          WHERE r.state IS DISTINCT FROM 'accepted' AND COALESCE(r.attempt_count,0)<6
            AND NOT EXISTS(SELECT 1 FROM public.subscription_events done WHERE done.subscription_id=x.subscription_id
              AND done.event_type='subscription.notice.suppressed'
              AND done.idempotency_key='notice-suppressed:'||x.source||':'||x.id::text)
            AND NOT EXISTS(SELECT 1 FROM public.outbox_events done WHERE done.aggregate_type='subscription_notice'
              AND done.aggregate_id=x.subscription_id AND done.event_type='subscription.notice.suppressed'
              AND done.idempotency_key=x.subscription_id::text||':notice-suppressed:'||x.source||':'||x.id::text)
            AND NOT EXISTS (SELECT 1 FROM public.subscription_notice_refusals refused
              WHERE refused.source=x.source AND refused.source_id=x.id)
          ORDER BY x.id LIMIT $1::integer`, [limit, [...Object.keys(aliases), "subscription.pause_reminder_due"]])).rows;
        const rows: Record<string, unknown>[] = [...dunning.map(row => ({ ...row, source: "dunning", client_id: row.recipient_ref, kind: row.notification_kind })), ...sources];
        for (const row of rows) {
          const source = row.source as NativeLifecycleNotice["source"];
          const key = `subscription-notice:${source}:${row.id}`;
          const locked = (await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key])).rows[0]?.locked;
          if (locked !== true) { result.busy++; continue; }
          const settle = async (status: "sent" | "queued" | "failed" | "skipped", reference: string) => {
            if (source !== "dunning") {
              if (row.outbox === true && (status === "sent" || status === "skipped")) await completeSystemNotice(db, String(row.id));
              return true;
            }
            if (status === "sent") return (await db.query(
              "SELECT public.subscription_dunning_mark_sent($1::uuid,$2::uuid,$3) AS ok",
              [row.id, row.claim_token, reference])).rows[0]?.ok === true;
            return (await db.query(`SELECT public.subscription_dunning_mark_result($1::uuid,$2::uuid,$3,$4,
              CASE WHEN $3='queued' THEN clock_timestamp()+make_interval(secs=>$5::integer) END) AS ok`,
            [row.id, row.claim_token, status, reference, dispatch.transientBackoffSeconds])).rows[0]?.ok === true;
          };
          try {
            if (source !== "dunning" && (await db.query(`SELECT source_id FROM public.subscription_notice_refusals
              WHERE source=$1 AND source_id=$2::uuid`, [source, row.id])).rows.length) {
              result.skipped++; continue;
            }
            if (source === "dunning" && row.recipient_kind !== "customer") throw new Error("subscription_notice_recipient_unsupported");
            if (source === "dunning" && !(await db.query(`SELECT id FROM public.subscription_dunning_notifications
              WHERE id=$1::uuid AND claim_token=$2::uuid AND status='sending' AND lease_expires_at>clock_timestamp()`, [row.id, row.claim_token])).rows.length) {
              result.stale++; continue;
            }
            const prior = await delivery.readReceipt(key);
            if (prior?.state === "accepted") {
              if (!prior.deliveryReference) throw new Error("subscription_notice_receipt_invalid");
              if (await settle("sent", prior.deliveryReference)) result.replayed++; else result.stale++;
              continue;
            }
            const kind = aliases[String(row.kind)] ?? String(row.kind);
            const payload = (row.payload ?? {}) as Record<string, unknown>;
            if (kind === "subscription.pause_reminder_due" && payload.pauseWindowId) {
              if (!(await db.query("SELECT id FROM public.subscription_pause_windows WHERE id=$1::uuid AND resumed_at IS NULL",
                [payload.pauseWindowId])).rows.length) {
                await systemNoticeIdentity(db, String(row.subscription_id), "subscription.notice.suppressed",
                  `notice-suppressed:${source}:${row.id}`, { reason: "pause_window_resolved", source, sourceId: String(row.id) }, true);
                if (row.outbox === true) await completeSystemNotice(db, String(row.id));
                result.skipped++; continue;
              }
            }
            if (kind === "subscription.renewal_upcoming" && typeof payload.renewalAt === "string") {
              const facts = (await db.query(`SELECT next_cycle_at=$2::timestamptz AS matching,
                public.subscription_renewal_purchase_terms(id) AS facts FROM public.subscriptions WHERE id=$1::uuid`,
              [row.subscription_id, payload.renewalAt])).rows[0];
              payload.phaseFactsAllowed = facts?.matching === true;
              payload.phaseFacts = facts?.matching === true ? facts.facts ?? null : null;
            }
            if (source === "dunning" && kind === "payment_recovered" && !(await db.query(`SELECT id
              FROM public.subscription_dunning_cases WHERE id=$1::uuid AND subscription_id=$2::uuid
                AND client_id=$3::uuid AND status='recovered'
                AND recovered_at>=clock_timestamp()-make_interval(secs=>$4::integer)`,
            [row.case_id, row.subscription_id, row.client_id, recovered.windowSeconds])).rows.length) {
              if (await settle("skipped", "notice_recovery_ineligible")) result.skipped++; else result.stale++;
              continue;
            }
            const recoverySource = source === "dunning" && kind === "payment_recovery"
              ? (await db.query(`SELECT template_slug,payload FROM public.subscription_dunning_notifications
                WHERE case_id=$1::uuid AND recipient_kind='customer' AND notification_kind='payment_failed'
                ORDER BY created_at DESC,id DESC LIMIT 1`, [row.case_id])).rows[0] : undefined;
            if (kind === "payment_recovery" && !recoverySource) {
              if (await settle("skipped", "notice_source_unavailable")) result.skipped++; else result.stale++;
              continue;
            }
            const templateSlug = recoverySource ? String(recoverySource.template_slug)
              : subscriptionLifecycleTemplate(kind, Number(row.retry_attempt ?? 0));
            if (!templateSlug) throw new Error("subscription_notice_kind_unsupported");
            const recipient = (await db.query("SELECT public.dunning_lifecycle_recipient($1::uuid) AS recipient", [row.client_id])).rows[0]?.recipient as { email: string; firstName: string | null; country: string | null } | null;
            const enabled = (await db.query("SELECT public.communications_notification_control_enabled($1::text[]) AS enabled", [["subscription", templateSlug]])).rows[0]?.enabled;
            const consent = recipient && (await db.query("SELECT public.communications_recipient_consent_state($1,$2::text[]) AS state",
              [createHash("sha256").update(recipient.email.trim().toLowerCase()).digest("hex"), [source === "dunning" ? "subscription_dunning" : "transactional"]])).rows[0]?.state;
            if (!recipient || enabled !== true || consent !== "unknown") {
              if (source === "dunning") {
                const skipped = (await db.query("SELECT public.subscription_dunning_mark_result($1::uuid,$2::uuid,'skipped','notice_policy_refused',NULL) AS ok", [row.id, row.claim_token])).rows[0]?.ok;
                if (skipped !== true) { result.stale++; continue; }
              } else {
                await db.query(`INSERT INTO public.subscription_notice_refusals(source,source_id,reason)
                  VALUES($1,$2::uuid,'notice_policy_refused') ON CONFLICT (source,source_id) DO NOTHING`, [source, row.id]);
                if (row.outbox === true) await completeSystemNotice(db, String(row.id));
              }
              result.skipped++; continue;
            }
            const notice: NativeLifecycleNotice = { id: String(row.id), messageKey: key, source,
              subscriptionId: String(row.subscription_id), clientId: String(row.client_id), kind, templateSlug,
              payload: (recoverySource?.payload ?? payload) as Record<string, unknown>, recoveryUrlPath: row.recovery_url_path == null ? null : String(row.recovery_url_path) };
            const receipt = await delivery.send({ ...await options.bind(notice, recipient), idempotencyKey: key });
            if (receipt.state === "failed") {
              if (receipt.retryable !== undefined && typeof receipt.retryable !== "boolean") {
                throw new Error("subscription_notice_receipt_invalid");
              }
              const status = source === "dunning" && receipt.retryable !== false ? "queued" : "failed";
              const reason = status === "queued" ? "notice_delivery_unavailable" : "notice_delivery_rejected";
              if (!await settle(status, reason)) result.stale++;
              else if (status === "queued") result.requeued++;
              else result.failed++;
            } else {
              if (receipt.state !== "accepted" || !receipt.deliveryReference) throw new Error("subscription_notice_receipt_invalid");
              if (await settle("sent", receipt.deliveryReference)) result.sent++; else result.stale++;
            }
          } catch {
            // Acceptance may be unknown. The existing receipt and lease own recovery.
            result.failed++;
          } finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
        }
        return result;
      });
    },
  };
}
