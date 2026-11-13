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
      const sourceEvidence = { sourceKind: "accepted_event", sourceReference: input.providerEventId,
        observedStatus: input.eventType, observedAt: input.occurredAt, payloadFingerprint };
      const normalized = input.rawPayload.openlupEvidence;
      const adapterFingerprint = normalized && typeof normalized === "object" && !Array.isArray(normalized)
        ? (normalized as Record<string, unknown>).fingerprint : undefined;
      if (adapterFingerprint !== undefined && (typeof adapterFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(adapterFingerprint))) {
        throw new Error("payment_event_fingerprint_invalid");
      }
      const eventFingerprint = adapterFingerprint as string | undefined ?? paymentSourceFingerprint({
        sourceEventId: `${input.provider}:${input.providerEventId}`, eventKind: input.eventType,
        settlementIntentId: input.paymentIntentId ?? null, amountMinor: input.amountMinor ?? null,
        currency: input.currency?.toUpperCase() ?? null, occurredAt: input.occurredAt, payloadFingerprint,
      });
      const parsed = receipt.safeParse((await db.query(
        "SELECT public.payment_provider_event_ingest($1,$2,$3,$4,$5::uuid,$6::uuid,$7::integer,$8,$9,$10::jsonb) AS response",
        [input.provider, input.providerEventId, input.eventType, input.providerPaymentId, input.paymentIntentId ?? null,
          input.paymentAttemptId ?? null, input.amountMinor ?? null, input.currency ?? null, true,
          JSON.stringify({ ...input.rawPayload, __paymentTruth: { fingerprint: eventFingerprint, evidence: sourceEvidence } })],
      )).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_event_receipt_unavailable");
      const event = parsed.data.paymentEvent;
      let occurredAt = input.occurredAt;
      if (event.replayed) {
        const stored = event.occurredAt;
        if (typeof stored !== "string" || !Number.isFinite(Date.parse(stored))) throw new Error("payment_event_receipt_unavailable");
        occurredAt = stored;
      }
      return { paymentEventId: event.id, paymentIntentId: event.paymentIntentId,
        paymentAttemptId: event.paymentAttemptId, replayed: event.replayed, occurredAt };
    },
    async applyPaymentResult(input) {
      return { replayed: (await control.applyPaymentResult(input)).replayed };
    },
  };
}
