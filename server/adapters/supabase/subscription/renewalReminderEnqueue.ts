export interface SubscriptionRenewalReminderEnqueueResult {
  enqueued: number;
}

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export function createSupabaseRenewalReminderEnqueuePort(client: RpcClient) {
  return {
    async enqueue(limit: number): Promise<SubscriptionRenewalReminderEnqueueResult> {
      const { data, error } = await client.rpc("enqueue_subscription_renewal_reminders", {
        p_limit: limit,
      });
      if (error) throw new Error(error.message ?? "enqueue_subscription_renewal_reminders_failed");
      return readEnqueueResult(data);
    },
  };
}

function readEnqueueResult(data: unknown): SubscriptionRenewalReminderEnqueueResult {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    return { enqueued: typeof record.enqueued === "number" ? record.enqueued : 0 };
  }
  return { enqueued: 0 };
}
