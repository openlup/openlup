export interface CheckoutRecoveryWavePolicy {
  firstOffsetSeconds?: number;
  finalOffsetSeconds?: number;
  checkoutSeconds?: number;
  recoverySeconds?: number;
  activitySeconds?: number;
  /** Distinct host-owned identity for each selected transport profile. */
  profile: string;
}
export interface CheckoutRecoveryWaveExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The supplied restricted executor owns each SQL transaction; no scheduler starts here. */
export function createPostgresCheckoutRecoveryWaves(executor: CheckoutRecoveryWaveExecutor, policy: CheckoutRecoveryWavePolicy) {
  const json = JSON.stringify(policy);
  const call = async <T>(sql: string, args: unknown[]): Promise<T> => {
    const row = (await executor.query(sql, args)).rows[0];
    if (!row || row.result == null) throw new Error('checkout_recovery_response_invalid');
    return row.result as T;
  };
  return {
    enqueue: (limit: number, now: string) => call<{ enqueued_1h: number; enqueued_20h: number }>(
      'SELECT public.commerce_enqueue_checkout_recovery_reminders($1::integer,$2::jsonb,$3::timestamptz) AS result', [limit, json, now]),
    expire: (limit: number, now: string) => call<{ checked: number; expired: number; released: number }>(
      'SELECT public.commerce_sweep_expired_checkouts($1::integer,$2::jsonb,$3::timestamptz) AS result', [limit, json, now]),
    sweepInitial: (limit: number, olderThan: string, now: string) => call<{ swept: number }>(
      'SELECT public.commerce_sweep_initial_checkouts($1::integer,$2::timestamptz,$3::jsonb,$4::timestamptz) AS result', [limit, olderThan, json, now]),
    reconcile: (limit: number, now: string) => call<{ checked: number; inserted: number }>(
      'SELECT public.commerce_reconcile_checkout_expired_events($1::integer,$2::jsonb,$3::timestamptz) AS result', [limit, json, now]),
    authorize: (eventId: string, claimToken: string) => call<{ authorized: boolean; reason?: string }>(
      'SELECT public.commerce_checkout_recovery_wave_delivery_authorize($1::uuid,$2::text) AS result', [eventId, claimToken]),
    async recordConfirmedSend(eventId: string, deliveryReference: string) {
      await call('SELECT public.commerce_checkout_recovery_record_sent($1::uuid,$2::text,$3::text) AS result',
        [eventId, policy.profile, deliveryReference]);
    },
  };
}
