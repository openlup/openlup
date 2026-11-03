import { createHash } from "node:crypto";
import type { SandboxPaymentSimulator } from "@openlup/platform/payments/contracts";

/** Capture fixture purchases through the simulator's durable observation and verified ingress. */
export async function captureSandboxPurchase(simulator: SandboxPaymentSimulator,
  input: { settlementIntentId: string; key: string; at: string }) {
  const attempt = await simulator.beginAttempt({ settlementIntentId: input.settlementIntentId,
    idempotencyKey: `purchase-attempt:${input.key}`, requestFingerprint: createHash("sha256").update(input.key).digest("hex"), at: input.at });
  const observation = await simulator.recordObservation({ attemptId: attempt.id,
    idempotencyKey: `purchase-observation:${input.key}`, outcome: "captured", occurredAt: input.at });
  return simulator.ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({
    settlementIntentId: input.settlementIntentId, attemptId: attempt.id, observationId: observation.id })), headers: {}, receivedAt: input.at });
}
