import { z } from "zod";
import type { PostgresPaymentTruthOptions } from "./contracts/truth.js";
import { paymentPayloadFingerprint, paymentSourceFingerprint } from "./paymentTruth.js";
import type { PaymentProviderExecutor } from "./postgresPreparedAttempt.js";
import { createPostgresProviderPaymentControlPort } from "./postgresProviderControl.js";
import type { PaymentWebhookControlPort } from "./verifiedIngress.js";

const receipt = z.object({ paymentEvent: z.object({ id: z.guid(), paymentIntentId: z.guid().nullable(),
  paymentAttemptId: z.guid().nullable(), replayed: z.boolean(), occurredAt: z.string().nullable() }) });

/** Verified ingress is persisted independently of result application. */
export function createPostgresPaymentWebhookControlPort(db: PaymentProviderExecutor, options: PostgresPaymentTruthOptions): PaymentWebhookControlPort {
  const control = createPostgresProviderPaymentControlPort(db, options);
  return {
    async ingestPaymentEvent(input) {
      const payloadFingerprint = paymentPayloadFingerprint(input.rawPayload);
      const normalized = input.rawPayload.openlupEvidence;
      const facts = normalized && typeof normalized === "object" && !Array.isArray(normalized)
        ? normalized as Record<string, unknown> : null;
      const hasProviderTime = facts !== null && Object.hasOwn(facts, "providerOccurredAt");
      let observedAt: string | null = input.occurredAt;
      if (hasProviderTime) {
        const supplied = facts!.providerOccurredAt;
        if (supplied !== null && (typeof supplied !== "string" || !Number.isFinite(Date.parse(supplied)))) {
          throw new Error("payment_event_receipt_unavailable");
        }
        observedAt = supplied;
      }
      const sourceEvidence = { sourceKind: "accepted_event", sourceReference: input.providerEventId,
        observedStatus: input.eventType, observedAt, payloadFingerprint };
      const adapterFingerprint = facts?.fingerprint;
      if (adapterFingerprint !== undefined && (typeof adapterFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(adapterFingerprint))) {
        throw new Error("payment_event_fingerprint_invalid");
      }
      const eventFingerprint = adapterFingerprint as string | undefined ?? paymentSourceFingerprint({
        sourceEventId: `${input.provider}:${input.providerEventId}`, eventKind: input.eventType,
        settlementIntentId: input.paymentIntentId ?? null, amountMinor: input.amountMinor ?? null,
        currency: input.currency?.toUpperCase() ?? null, occurredAt: observedAt, payloadFingerprint,
      });
      // The opt-in receipt envelope captures the same database transaction time
      // as evidence.created_at; redelivery reads those committed bytes unchanged.
      const parsed = receipt.safeParse((await db.query(
        `SELECT public.payment_provider_event_ingest($1,$2,$3,$4,$5::uuid,$6::uuid,$7::integer,$8,$9,
          CASE WHEN jsonb_typeof($10::jsonb->'openlupReceipt')='object' THEN
            jsonb_set($10::jsonb,'{openlupReceipt,recordedAt}',
              to_jsonb(to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),true)
          ELSE $10::jsonb END) AS response`,
        [input.provider, input.providerEventId, input.eventType, input.providerPaymentId, input.paymentIntentId ?? null,
          input.paymentAttemptId ?? null, input.amountMinor ?? null, input.currency ?? null, true,
          JSON.stringify({ ...input.rawPayload, __paymentTruth: { fingerprint: eventFingerprint, evidence: sourceEvidence } })],
      )).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_event_receipt_unavailable");
      const event = parsed.data.paymentEvent;
      const occurredAt = event.occurredAt;
      if (occurredAt === null) {
        if (!hasProviderTime || observedAt !== null) throw new Error("payment_event_receipt_unavailable");
        return { paymentEventId: event.id, paymentIntentId: event.paymentIntentId,
          paymentAttemptId: event.paymentAttemptId, replayed: event.replayed };
      }
      if (!Number.isFinite(Date.parse(occurredAt)) || (hasProviderTime && observedAt === null)) throw new Error("payment_event_receipt_unavailable");
      return { paymentEventId: event.id, paymentIntentId: event.paymentIntentId,
        paymentAttemptId: event.paymentAttemptId, replayed: event.replayed, occurredAt };
    },
    async markSetupEventProcessed(input) {
      const value = (await db.query("SELECT public.payment_control_mark_setup_event_processed($1::uuid) AS response", [input.paymentEventId])).rows[0]?.response;
      return z.object({ setupEventProcessed: z.object({ updated: z.boolean() }) }).parse(value).setupEventProcessed;
    },
    async applyPaymentResult(input) {
      return { replayed: (await control.applyPaymentResult(input)).replayed };
    },
  };
}
