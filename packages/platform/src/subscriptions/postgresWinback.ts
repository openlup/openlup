import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

type WinbackCommand = { idempotencyKey: string; recipientReference: string; templateReference: string };
type WinbackReceipt = { state: "accepted" | "failed"; deliveryReference: string | null; attemptCount: number };
export interface NativeWinbackOptions {
  /** An exclusive autocommit session, never a transaction spanning transport. */
  withSession<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** The existing durable delivery rail owns ambiguous acceptance and retries. */
  delivery: {
    readReceipt(key: string): Promise<WinbackReceipt | null>;
    send(command: WinbackCommand): Promise<WinbackReceipt>;
  };
  /** Trusted host binds neutral content and the localized account landing. */
  bind(input: { subscriptionId: string; clientId: string; email: string; firstName: string | null; country: string | null }): Promise<Omit<WinbackCommand, "idempotencyKey">>;
}

/** Explicit winback-only selection; no dispatcher alias or other retention planner. */
export function createPostgresSubscriptionWinback(options: NativeWinbackOptions) {
  return {
    async run(limit = 25) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("subscription_winback_limit_invalid");
      return options.withSession(async db => {
        const plan = (await db.query("SELECT public.subscriber_retention_plan_due('winback',$1::integer) AS plan", [limit])).rows[0]!.plan;
        const result = { plan, scanned: 0, sent: 0, deduped: 0, refused: 0, failed: 0, busy: 0 };
        const candidates = (await db.query(`SELECT i.idempotency_key,i.fingerprint,i.subscription_id,
          i.source_reference,i.status,i.dispatch_claim_reference,i.attempt_count,
          s.client_id,c.email,c.first_name,c.country
          FROM public.subscriber_retention_intents i JOIN public.subscriptions s ON s.id=i.subscription_id
          JOIN public.clients c ON c.id=s.client_id WHERE i.kind='winback'
          AND (i.status IN ('planned','failed') OR i.status='dispatching' AND i.dispatch_claim_expires_at<=now())
          ORDER BY i.created_at,i.id LIMIT $1`, [limit])).rows;
        for (const candidate of candidates) {
          result.scanned++;
          // Database UUID spelling, rather than caller text, owns subscription identity.
          const subscriptionId = String(candidate.subscription_id), key = `winback:${subscriptionId}`;
          const locked = (await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key])).rows[0]?.locked;
          if (locked !== true) { result.busy++; continue; }
          try {
            const previous = await options.delivery.readReceipt(key);
            if (previous?.state === "accepted") {
              validateReceipt(previous);
              // Recover acceptance after a crash before the original claim was settled.
              if (candidate.status === "dispatching") {
                await record(db, candidate, previous, String(candidate.dispatch_claim_reference));
              }
              result.deduped++;
              continue;
            }
            const claimed = (await db.query(`SELECT public.subscriber_retention_claim_intent($1,$2) AS claim`,
              [candidate.idempotency_key, candidate.fingerprint])).rows[0]!.claim as Record<string, unknown> | null;
            if (!claimed) { result.refused++; continue; }
            const command = await options.bind({ subscriptionId, clientId: String(candidate.client_id),
              email: String(candidate.email), firstName: candidate.first_name == null ? null : String(candidate.first_name),
              country: candidate.country == null ? null : String(candidate.country) });
            const receipt = await options.delivery.send({ ...command, idempotencyKey: key });
            validateReceipt(receipt);
            await record(db, candidate, receipt, String(claimed.dispatchClaimReference));
            if (receipt.state === "accepted") result.sent++; else result.failed++;
          } catch {
            // Leave an ambiguous dispatch to its persisted receipt and expiring claim.
            result.failed++;
          } finally {
            await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
          }
        }
        return result;
      });
    },
  };
}

function validateReceipt(receipt: WinbackReceipt) {
  if (!Number.isInteger(receipt.attemptCount) || receipt.attemptCount < 1
    || !["accepted", "failed"].includes(receipt.state)
    || (receipt.state === "accepted" ? !receipt.deliveryReference : receipt.deliveryReference !== null)) {
    throw new Error("subscription_winback_receipt_invalid");
  }
}
async function record(db: SubscriptionQueryExecutor, candidate: Record<string, unknown>, receipt: WinbackReceipt, claim: string) {
  await db.query("SELECT public.subscriber_retention_record_delivery($1,$2,$3,$4,$5::integer,$6)",
    [candidate.idempotency_key, candidate.fingerprint, receipt.state, receipt.deliveryReference, receipt.attemptCount, claim]);
  if (receipt.state === "accepted") {
    await db.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
      VALUES($1::uuid,'subscription.winback.email_sent',$2,jsonb_build_object('channel','email','source','subscription-winback'))
      ON CONFLICT (subscription_id,idempotency_key) DO NOTHING`, [candidate.subscription_id, candidate.idempotency_key]);
  }
}
