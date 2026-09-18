export interface PaymentEventSweepResult {
  eventsIgnored: number;
  /**
   * Aged setup.* events still 'received' — their webhook pipeline never
   * completed (a crash after ingest, or a pre-fix row the provider never
   * redelivered). Count-only anomaly signal; 0 when the DB predates the field.
   */
  staleSetupReceived: number;
}

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export function createSupabasePaymentEventSweepPort(client: RpcClient) {
  return {
    async sweep(input: { now: string; graceMinutes: number; limit: number }): Promise<PaymentEventSweepResult> {
      const { data, error } = await client.rpc("commerce_sweep_orphan_payment_events", {
        p_idempotency_prefix: "commerce-payment-event-sweep-run",
        p_now: input.now,
        p_grace_minutes: input.graceMinutes,
        p_limit: input.limit,
      });
      if (error) throw new Error(`rpc_sweep: ${error.message ?? "unknown"}`);
      return readSweepResult(data);
    },
  };
}

function readSweepResult(data: unknown): PaymentEventSweepResult {
  const sweep = (data as { orphanEventSweep?: Record<string, unknown> } | null)?.orphanEventSweep;
  return {
    eventsIgnored: readCount(sweep?.eventsIgnored),
    staleSetupReceived: readCount(sweep?.staleSetupReceived),
  };
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
