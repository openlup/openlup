import type { NativeLifecycleMessagesOptions, NativeLifecycleNotice } from "./postgresLifecycleMessages.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

type Policy = Required<NonNullable<NativeLifecycleMessagesOptions["notices"]>>;
type Counters = { sent: number; replayed: number; requeued: number; failed: number; skipped: number; busy: number; stale: number };

/** Outcome history is separate from deliverable aliases and policy refusals. */
export async function runAtRiskNotices(options: NativeLifecycleMessagesOptions, db: SubscriptionQueryExecutor,
  limit: number, policy: Policy, result: Counters): Promise<void> {
  const candidates = (await db.query(`SELECT *,to_char(next_cycle_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS renewal_at FROM public.dunning_lifecycle_scan_at_risk_service($1,$2,$3)`,
  [policy.atRiskMinDays, policy.atRiskMaxDays, limit])).rows;
  for (const row of candidates) {
    const cause = row.health_state === "method_missing" ? "missing" : row.health_state === "mandate_not_chargeable_unattended" ? "mandate" : null;
    if (!cause) { result.skipped++; continue; }
    const renewalAt = String(row.renewal_at), day = renewalAt.slice(0, 10);
    const lock = `subscription-notice:at-risk:${row.subscription_id}:${cause}`;
    if ((await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lock])).rows[0]?.locked !== true) {
      result.busy++; continue;
    }
    try {
      const history = (await db.query(`WITH notices AS (${systemNoticeEvents}) SELECT DISTINCT n.payload->>'renewalDay' AS day
        FROM notices n LEFT JOIN public.transactional_delivery_receipts r
          ON r.idempotency_key='subscription-notice:event:'||n.id::text
        WHERE n.subscription_id=$1::uuid AND n.event_type='subscription.notice.at_risk'
          AND n.payload->>'cause'=$2 AND (r.state='accepted' OR EXISTS(
            SELECT 1 FROM notices o WHERE o.subscription_id=n.subscription_id
              AND o.event_type='subscription.notice.at_risk_outcome' AND o.payload->>'outcome'='disabled'
              AND o.payload->>'cause'=n.payload->>'cause'
              AND o.payload->>'renewalDay'=n.payload->>'renewalDay'))`, [row.subscription_id, cause])).rows.map(value => String(value.day));
      if (history.length >= policy.atRiskMaxDaysPerCause || history.some(value => value >= day)) { result.skipped++; continue; }
      // Recipient absence is not an attempt and consumes no recorded day.
      const recipient = (await db.query("SELECT public.dunning_lifecycle_recipient($1::uuid) AS recipient", [row.client_id])).rows[0]?.recipient as
        { email: string; firstName: string | null; country: string | null } | null;
      if (!recipient) { result.skipped++; continue; }
      const identity = `at-risk:${cause}:${day}`;
      const payload = { cause, renewalDay: day, renewalAt };
      const stored = await systemNoticeIdentity(db, String(row.subscription_id), "subscription.notice.at_risk", identity, payload);
      const key = `subscription-notice:event:${stored.id}`, templateSlug = "subscription-renewal-at-risk";
      const enabled = (await db.query("SELECT public.communications_notification_control_enabled($1::text[]) AS enabled", [[templateSlug]])).rows[0]?.enabled;
      if (enabled !== true) {
        await systemNoticeIdentity(db, String(row.subscription_id), "subscription.notice.at_risk_outcome",
          `at-risk-outcome:${cause}:${day}`, { ...payload, noticeId: stored.id, outcome: "disabled" }, true);
        if (stored.outbox) await completeSystemNotice(db, stored.id);
        result.skipped++; continue;
      }
      // This state-scanned operational notice has the reference path's template
      // control, not a marketing/transactional consent substitution.
      const notice: NativeLifecycleNotice = { id: String(stored.id), source: "event", messageKey: key,
        subscriptionId: String(row.subscription_id), clientId: String(row.client_id), kind: "subscription.renewal_at_risk",
        templateSlug, payload, recoveryUrlPath: null };
      const prior = await options.delivery.readReceipt(key);
      if (prior?.state === "accepted" && prior.deliveryReference) {
        if (stored.outbox) await completeSystemNotice(db, stored.id);
        result.replayed++; continue;
      }
      const receipt = await options.delivery.send({ ...await options.bind(notice, recipient), idempotencyKey: key });
      if (receipt.state !== "accepted" || !receipt.deliveryReference) { result.failed++; continue; }
      if (stored.outbox) await completeSystemNotice(db, stored.id);
      result.sent++;
    } catch { result.failed++; }
    finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]); }
  }
}

/** Only these explicit fields can reach the host's operator mail binder. */
export async function runOperatorNotices(options: NativeLifecycleMessagesOptions, db: SubscriptionQueryExecutor,
  limit: number, policy: Policy, result: Counters): Promise<void> {
  if (!options.bindOperator) return;
  const rows = (await db.query("SELECT * FROM public.subscription_dunning_claim_operator_batch($1,$2,$3,$4)",
    [limit, policy.operatorLeaseSeconds, policy.operatorMaxAttempts, policy.operatorHorizonSeconds])).rows;
  for (const row of rows) {
    const key = `subscription-notice:dunning:${row.notification_id}`;
    if ((await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key])).rows[0]?.locked !== true) {
      result.busy++; continue;
    }
    const settle = async (status: "sent" | "queued" | "failed" | "skipped", reason: string) => {
      const response = status === "sent"
        ? await db.query("SELECT public.subscription_dunning_mark_sent($1::uuid,$2::uuid,$3) AS ok", [row.notification_id, row.claim_token, reason])
        : await db.query(`SELECT public.subscription_dunning_mark_result($1::uuid,$2::uuid,$3,$4,
          CASE WHEN $3='queued' THEN clock_timestamp()+make_interval(secs=>$5::integer) END) AS ok`,
        [row.notification_id, row.claim_token, status, reason, policy.operatorTransientBackoffSeconds]);
      if (response.rows[0]?.ok !== true) { result.stale++; return; }
      if (status === "sent") result.sent++;
      else if (status === "queued") result.requeued++;
      else if (status === "failed") result.failed++;
      else result.skipped++;
    };
    try {
      const prior = await options.delivery.readReceipt(key);
      if (prior?.state === "accepted" && prior.deliveryReference) { await settle("sent", prior.deliveryReference); continue; }
      const eligible = (await db.query("SELECT public.subscription_dunning_operator_delivery_eligible($1::uuid,$2::uuid) AS ok",
        [row.notification_id, row.claim_token])).rows[0]?.ok;
      const enabled = (await db.query("SELECT public.communications_notification_control_enabled($1::text[]) AS enabled", [[String(row.template_slug)]])).rows[0]?.enabled;
      if (eligible !== true || enabled !== true) { await settle("skipped", "notice_policy_refused"); continue; }
      const command = await options.bindOperator({ notificationId: String(row.notification_id), caseId: String(row.case_id),
        templateSlug: String(row.template_slug) }, { email: String(row.recipient_email) });
      const receipt = await options.delivery.send({ ...command, idempotencyKey: key });
      if (receipt.state === "accepted") {
        if (receipt.deliveryReference) await settle("sent", receipt.deliveryReference);
        else await settle("failed", "notice_delivery_acceptance_unknown_manual_review");
      } else if (receipt.retryable === true) await settle("queued", "notice_delivery_retryable");
      else await settle("failed", "notice_delivery_rejected");
    } catch { result.failed++; /* The fenced lease and receipt reconcile ambiguous work. */ }
    finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
  }
}

/** Legacy IDs survive; immutable typed keys preserve the permanent cap after payload compaction. */
export const systemNoticeEvents = `
  SELECT id,subscription_id,event_type,idempotency_key,payload FROM public.subscription_events
  WHERE event_type IN ('subscription.pause_reminder_due','subscription.notice.at_risk',
    'subscription.notice.at_risk_outcome','subscription.notice.suppressed')
  UNION ALL
  SELECT id,aggregate_id,event_type,idempotency_key,payload||CASE
    WHEN event_type IN ('subscription.notice.at_risk','subscription.notice.at_risk_outcome') THEN
      jsonb_build_object('cause',split_part(idempotency_key,':',3),'renewalDay',split_part(idempotency_key,':',4))
      ||CASE WHEN event_type='subscription.notice.at_risk_outcome' THEN '{"outcome":"disabled"}'::jsonb ELSE '{}'::jsonb END
    WHEN event_type='subscription.notice.suppressed' THEN
      jsonb_build_object('source',split_part(idempotency_key,':',3),'sourceId',split_part(idempotency_key,':',4))
    ELSE '{}'::jsonb END FROM public.outbox_events
  WHERE aggregate_type='subscription_notice' AND event_type IN ('subscription.pause_reminder_due',
    'subscription.notice.at_risk','subscription.notice.at_risk_outcome','subscription.notice.suppressed')`;

export async function systemNoticeIdentity(db: SubscriptionQueryExecutor, subscriptionId: string,
  eventType: string, identity: string, payload: Record<string, unknown>, terminal = false): Promise<{ id: string; outbox: boolean }> {
  const legacy = (await db.query(`SELECT id FROM public.subscription_events
    WHERE subscription_id=$1::uuid AND event_type=$2 AND idempotency_key=$3`, [subscriptionId, eventType, identity])).rows[0];
  if (legacy) return { id: String(legacy.id), outbox: false };
  const key = `${subscriptionId}:${identity}`;
  const inserted = (await db.query(`INSERT INTO public.outbox_events
    (aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,processed_at)
    VALUES('subscription_notice',$1::uuid,$2,$3,$4::jsonb,CASE WHEN $5 THEN 'processed' ELSE 'pending' END,
      CASE WHEN $5 THEN now() END)
    ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING id`,
  [subscriptionId, eventType, key, JSON.stringify(payload), terminal])).rows[0];
  const stored = inserted ?? (await db.query(`SELECT id FROM public.outbox_events
    WHERE aggregate_type='subscription_notice' AND aggregate_id=$1::uuid AND event_type=$2 AND idempotency_key=$3`,
  [subscriptionId, eventType, key])).rows[0];
  if (!stored) throw new Error("subscription_notice_source_missing");
  return { id: String(stored.id), outbox: true };
}

export async function completeSystemNotice(db: SubscriptionQueryExecutor, id: string): Promise<void> {
  await db.query(`UPDATE public.outbox_events SET status='processed',processed_at=coalesce(processed_at,now()),error=NULL
    WHERE id=$1::uuid AND aggregate_type='subscription_notice'
      AND event_type IN ('subscription.pause_reminder_due','subscription.notice.at_risk')`, [id]);
}

/** Receipt-first reconciliation also releases the shared outbox ordering barrier after a crash. */
export async function reconcileSystemNotices(db: SubscriptionQueryExecutor): Promise<void> {
  await db.query(`WITH notices AS (${systemNoticeEvents})
    UPDATE public.outbox_events n SET status='processed',processed_at=coalesce(n.processed_at,now()),error=NULL
    WHERE n.aggregate_type='subscription_notice' AND n.event_type IN ('subscription.pause_reminder_due','subscription.notice.at_risk')
      AND n.status<>'processed' AND (EXISTS(SELECT 1 FROM public.transactional_delivery_receipts r
        WHERE r.idempotency_key='subscription-notice:event:'||n.id::text AND r.state='accepted')
      OR EXISTS(SELECT 1 FROM public.subscription_notice_refusals r WHERE r.source='event' AND r.source_id=n.id)
      OR EXISTS(SELECT 1 FROM notices o WHERE o.subscription_id=n.aggregate_id
        AND ((n.event_type='subscription.notice.at_risk' AND o.event_type='subscription.notice.at_risk_outcome'
            AND o.payload->>'outcome'='disabled' AND o.payload->>'cause'=n.payload->>'cause'
            AND o.payload->>'renewalDay'=n.payload->>'renewalDay')
          OR (o.event_type='subscription.notice.suppressed' AND o.payload->>'source'='event' AND o.payload->>'sourceId'=n.id::text))))`);
}
