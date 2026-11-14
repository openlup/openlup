import { z } from "zod";
import type { PreparedAttemptPersistencePort } from "./contracts/preparedAttempt.js";

export interface PaymentProviderExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const attempt = z.object({ paymentAttempt: z.object({
  id: z.guid(), status: z.enum(["created", "blocked_preflight", "sent_to_provider", "requires_action", "processing", "succeeded", "failed", "cancelled", "expired"]),
  replayed: z.boolean(), providerAttemptId: z.string().nullable(), providerSessionId: z.string().nullable(), nextActionKind: z.string().nullable(),
}) });

/** Direct PostgreSQL persistence; each call completes before provider execution. */
export function createPostgresPreparedAttemptPersistencePort(db: PaymentProviderExecutor): PreparedAttemptPersistencePort {
  return {
    async prepareProviderAttempt(input) {
      return decodeProviderAttempt((await db.query(
        "SELECT public.payment_provider_attempt_prepare($1,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb) AS response",
        [input.idempotencyKey, input.paymentIntentId, input.provider, input.providerIdempotencyKey,
          input.providerRequestFingerprint, input.providerFlow, input.paymentMethodRef ?? null, JSON.stringify(input.requestPayload)],
      )).rows[0]?.response);
    },
    async finalizeProviderAttempt(input) {
      return decodeProviderAttempt((await db.query(
        "SELECT public.payment_provider_attempt_finalize($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) AS response",
        [input.idempotencyKey, input.paymentIntentId, input.paymentAttemptId, input.providerIdempotencyKey,
          input.providerRequestFingerprint, input.providerAttemptId, input.providerSessionId, input.attemptStatus,
          input.nextActionKind, JSON.stringify(input.requestPayload), JSON.stringify(input.responsePayload)],
      )).rows[0]?.response);
    },
  };
}

export function decodeProviderAttempt(value: unknown) {
  const parsed = attempt.safeParse(value);
  if (!parsed.success) {
    const admission = z.object({ paymentAttemptAdmission: z.object({ reason: z.string() }) }).safeParse(value);
    throw new Error(admission.success ? admission.data.paymentAttemptAdmission.reason : "payment_provider_attempt_readback_invalid");
  }
  const a = parsed.data.paymentAttempt;
  return { paymentAttemptId: a.id, status: a.status, replayed: a.replayed,
    providerAttemptId: a.providerAttemptId, providerSessionId: a.providerSessionId, nextActionKind: a.nextActionKind };
}
