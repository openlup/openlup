import { z } from "../../src/lib/validation/zod.js";
import type { PaymentRecoveryEvidence } from "@openlup/core/payment";
import type { PaymentFailureEvidence } from "./paymentFailureEvidence.js";
import { normalizeStripeFailureEvidence } from "./stripe/stripeFailureEvidence.js";
import { normalizeTpayFailureEvidence } from "./tpay/tpayFailureEvidence.js";

const token = z.string().regex(/^[a-zA-Z0-9_:.-]{1,96}$/);
const evidenceSchema = z.object({
  version: z.literal(1), source: z.enum(["execution", "webhook", "readback"]),
  disposition: z.enum(["present", "absent", "unreadable", "read_failed", "read_timeout"]),
  refusalVerified: z.boolean(), providerPaymentId: token.nullable(), providerChargeId: token.nullable(),
  code: token.nullable(), declineCode: token.nullable(), adviceCode: token.nullable(),
  adviceOrigin: z.enum(["provider", "inferred", "unknown"]),
  operation: z.enum(["one_time_payment", "recurring_setup", "stored_method_payment"]).nullable(),
  method: z.object({ kind: token, recoveryMethodKey: token,
    interaction: z.enum(["new_instrument", "stored_instrument"]) }).strict().nullable(),
  methodSource: z.enum(["provider", "execution_contract", "unknown"]),
}).strict();

export interface PaymentRecoveryAdapter {
  provider: string;
  normalize(input: PaymentFailureEvidence): PaymentRecoveryEvidence;
}

/** SQL proves row/attempt identity; this boundary validates diagnostic provenance. */
export function createPaymentRecoveryEvidenceNormalizer(adapters: readonly PaymentRecoveryAdapter[] = [
  { provider: "stripe", normalize: normalizeStripeFailureEvidence },
  { provider: "tpay", normalize: normalizeTpayFailureEvidence },
]): (input: { provider: string; evidence: unknown[] }) => PaymentRecoveryEvidence | null {
  const registry = new Map<string, PaymentRecoveryAdapter>();
  for (const adapter of adapters) {
    if (registry.has(adapter.provider)) throw new Error("duplicate_payment_recovery_adapter");
    registry.set(adapter.provider, adapter);
  }
  return ({ provider, evidence }) => {
    const adapter = registry.get(provider);
    if (!adapter || !evidence.length || evidence.length > 32) return null;
    const observations: PaymentFailureEvidence[] = [];
    for (const raw of evidence) {
      const parsed = evidenceSchema.safeParse(raw);
      // A malformed member cannot be silently skipped in favor of a specific cause.
      if (!parsed.success) return null;
      const entry = parsed.data as PaymentFailureEvidence;
      if (entry.method && entry.methodSource === "unknown") return null;
      observations.push(entry);
    }
    const charges = new Set(observations.map((entry) => entry.providerChargeId).filter(Boolean));
    const payments = new Set(observations.map((entry) => entry.providerPaymentId).filter(Boolean));
    // No trusted latest-Charge pointer exists in this snapshot. Never choose one
    // historical failure when a local attempt encompasses several provider charges.
    if (charges.size > 1 || payments.size > 1) return null;
    // An unreadable conflicting observation cannot be discarded in favor of
    // an older specific refusal. Transport absence/timeouts are not contradictions.
    if (observations.some((entry) => entry.disposition === "unreadable")) return null;
    const facts = observations.filter((entry) => entry.refusalVerified).map((entry) => adapter.normalize(entry));
    if (!facts.length) return null;
    const first = facts[0]!;
    const same = <T>(select: (fact: PaymentRecoveryEvidence) => T): T | null => {
      const value = select(first);
      return facts.every((fact) => JSON.stringify(select(fact)) === JSON.stringify(value)) ? value : null;
    };
    // Missing method/operation knowledge is not a conflicting fact. Keep the
    // whole known value only when every observation that knows it agrees.
    const sameKnown = <T>(select: (fact: PaymentRecoveryEvidence) => T | null): T | null => {
      const known = facts.map(select).filter((value): value is T => value !== null);
      const value = known[0] ?? null;
      return known.every((item) => JSON.stringify(item) === JSON.stringify(value)) ? value : null;
    };
    const restricted = facts.some((fact) => fact.disclosure === "restricted");
    const cause = restricted ? "generic_decline" : same((fact) => fact.cause) ?? "generic_decline";
    return {
      refusalVerified: facts.every((fact) => fact.refusalVerified), cause,
      certainty: cause !== "generic_decline" && facts.every((fact) => fact.certainty === "verified") ? "verified" : "unknown",
      disclosure: restricted ? "restricted" : "safe",
      method: sameKnown((fact) => fact.method), operation: sameKnown((fact) => fact.operation),
      advice: same((fact) => fact.advice),
    };
  };
}
