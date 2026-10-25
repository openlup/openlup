import {
  ORDER_FEEDBACK_SUBMIT_RPC_NAME,
  type OrderFeedbackSubmitRequest,
} from "../orderFeedbackContracts.js";

interface RpcError {
  message?: string;
}

export interface OrderFeedbackSubmitRpcClient {
  rpc(
    functionName: typeof ORDER_FEEDBACK_SUBMIT_RPC_NAME,
    args: {
      p_token: string;
      p_rating: number;
      p_comment: string | null;
    },
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface OrderFeedbackSubmitPort {
  submit(request: OrderFeedbackSubmitRequest): Promise<unknown>;
}

/** Hosted token feedback only; the adopter must provide this RPC. Native db/platform has no binding. */
export function createSupabaseOrderFeedbackSubmitPort(
  client: OrderFeedbackSubmitRpcClient,
): OrderFeedbackSubmitPort {
  return {
    async submit(request) {
      const { data, error } = await client.rpc(ORDER_FEEDBACK_SUBMIT_RPC_NAME, {
        p_token: request.token,
        p_rating: request.rating,
        p_comment: request.comment ?? null,
      });
      if (error) throw new Error(error.message ?? "order_feedback_submit_failed");
      return data;
    },
  };
}
