import type { PaymentProviderExecutor } from "./postgresPreparedAttempt.js";

/** A healthy legacy label or a mirror string is never reusable provider evidence. */
export function createPostgresRecordedSubscriptionMethodReader(db: PaymentProviderExecutor) {
  return { async read(subscriptionId: string) {
    const value = (await db.query("SELECT public.subscription_method_health_read($1::uuid) AS response", [subscriptionId])).rows[0]?.response;
    const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
    if (!row?.payment_method_ref_id || !row.provider_method_ref) return { kind: "unavailable", reason: "method_ref_not_recorded" } as const;
    return { kind: "recorded", methodRef: String(row.provider_method_ref), evidenceRef: String(row.payment_method_ref_id),
      provider: String(row.provider_kind), customerRef: row.provider_customer_ref == null ? null : String(row.provider_customer_ref),
      healthState: String(row.health_state), consentSnapshot: row.consent_snapshot, expiresAt: row.method_expires_at } as const;
  } };
}
