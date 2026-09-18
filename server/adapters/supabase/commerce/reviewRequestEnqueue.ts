import type { ReviewRequestEnqueuePort } from "../../../domains/commerce/outboxDispatchContracts.js";

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export function createSupabaseReviewRequestEnqueuePort(
  client: RpcClient,
): ReviewRequestEnqueuePort {
  return {
    async enqueueRequests(limit: number): Promise<number> {
      return enqueueNumber(client, "enqueue_review_requests", limit);
    },
    async enqueueEffects(limit: number): Promise<number> {
      return enqueueNumber(client, "enqueue_review_effects", limit);
    },
  };
}

async function enqueueNumber(client: RpcClient, rpcName: string, limit: number): Promise<number> {
  const { data, error } = await client.rpc(rpcName, { p_limit: limit });
  if (error) throw new Error(error.message ?? `${rpcName}_failed`);
  return typeof data === "number" ? data : 0;
}
