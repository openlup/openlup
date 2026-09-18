export interface SweptRow {
  subscriptionId: string;
  orderId: string | null;
}

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export function createManagedSubscriptionSweepPort(client: RpcClient) {
  return {
    async sweep(input: { olderThan: string; limit: number }): Promise<SweptRow[]> {
      const { data, error } = await client.rpc("subscription_sweep_unpaid_provisional", {
        p_idempotency_prefix: "subscription-sweep-run",
        p_older_than: input.olderThan,
        p_limit: input.limit,
      });
      if (error) throw new Error(`rpc_sweep: ${error.message ?? "unknown"}`);
      return parseSwept(data);
    },
  };
}

function parseSwept(data: unknown): SweptRow[] {
  const sweep = (data as { sweep?: { swept?: unknown } } | null)?.sweep?.swept;
  if (!Array.isArray(sweep)) return [];
  return sweep
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      subscriptionId: typeof row.subscriptionId === "string" ? row.subscriptionId : "",
      orderId: typeof row.orderId === "string" ? row.orderId : null,
    }))
    .filter((row) => row.subscriptionId.length > 0);
}
