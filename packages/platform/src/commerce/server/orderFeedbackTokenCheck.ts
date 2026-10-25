import {
  ORDER_FEEDBACK_CHECK_RPC_NAME,
  type OrderFeedbackTokenCheckRequest,
} from "../orderFeedbackContracts.js";

interface RpcError {
  message?: string;
}

export interface OrderFeedbackTokenCheckRpcClient {
  rpc(
    functionName: typeof ORDER_FEEDBACK_CHECK_RPC_NAME,
    args: { p_token: string },
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/** Hosted token feedback only; the adopter must provide this RPC. Native db/platform has no binding. */
export function createSupabaseOrderFeedbackTokenCheckPort(client: OrderFeedbackTokenCheckRpcClient) {
  return {
    async check(request: OrderFeedbackTokenCheckRequest): Promise<unknown> {
      const { data, error } = await client.rpc(ORDER_FEEDBACK_CHECK_RPC_NAME, {
        p_token: request.token,
      });
      if (error) throw new Error(error.message ?? "order_feedback_token_check_failed");
      return data;
    },
  };
}
