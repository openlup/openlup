export interface ReservationSweepCounts {
  ordersChecked: number;
  ordersExpired: number;
  reservationsReleased: number;
  skippedPaid: number;
  skippedTerminal: number;
  skippedSubscription: number;
}

export type ReservationSweepRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export interface RetryHoldSweepCounts {
  holdsChecked: number;
  holdsReleased: number;
  skippedPaid: number;
}

export function createManagedReservationSweepPort(client: ReservationSweepRpcClient) {
  return {
    async sweep(input: { now: string; limit: number }): Promise<ReservationSweepCounts> {
      const { data, error } = await client.rpc("commerce_sweep_expired_reservation_holds", {
        p_idempotency_prefix: "commerce-reservation-sweep-run",
        p_now: input.now,
        p_limit: input.limit,
      });
      if (error) throw new Error(`rpc_sweep: ${error.message ?? "unknown"}`);
      return readSweepCounts(data);
    },
    // Release-only: frees expired subscription_retry_window holds without
    // touching the cycle order, subscription, or dunning case.
    async sweepRetryHolds(input: { now: string; limit: number }): Promise<RetryHoldSweepCounts> {
      const { data, error } = await client.rpc("commerce_sweep_expired_retry_holds", {
        p_now: input.now,
        p_limit: input.limit,
      });
      if (error) throw new Error(`rpc_retry_hold_sweep: ${error.message ?? "unknown"}`);
      const sweep = (data as { retrySweep?: Record<string, unknown> } | null)?.retrySweep;
      return {
        holdsChecked: numberField(sweep, "holdsChecked"),
        holdsReleased: numberField(sweep, "holdsReleased"),
        skippedPaid: numberField(sweep, "skippedPaid"),
      };
    },
  };
}

function readSweepCounts(data: unknown): ReservationSweepCounts {
  const sweep = (data as { sweep?: Record<string, unknown> } | null)?.sweep;
  return {
    ordersChecked: numberField(sweep, "ordersChecked"),
    ordersExpired: numberField(sweep, "ordersExpired"),
    reservationsReleased: numberField(sweep, "reservationsReleased"),
    skippedPaid: numberField(sweep, "skippedPaid"),
    skippedTerminal: numberField(sweep, "skippedTerminal"),
    skippedSubscription: numberField(sweep, "skippedSubscription"),
  };
}

function numberField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
