import type {
  ReorderReminderEnqueuePort,
  ReorderReminderEnqueueResult,
} from "../../../domains/commerce/outboxDispatchContracts.js";

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export function createSupabaseReorderReminderEnqueuePort(
  client: RpcClient,
): ReorderReminderEnqueuePort {
  return {
    async enqueue(limit: number): Promise<ReorderReminderEnqueueResult> {
      const { data, error } = await client.rpc("enqueue_reorder_reminders", {
        p_limit: limit,
      });
      if (error) throw new Error(error.message ?? "enqueue_reorder_reminders_failed");
      return readEnqueueResult(data);
    },
  };
}

function readEnqueueResult(data: unknown): ReorderReminderEnqueueResult {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    return {
      enqueued: typeof record.enqueued === "number" ? record.enqueued : 0,
    };
  }
  return { enqueued: 0 };
}
