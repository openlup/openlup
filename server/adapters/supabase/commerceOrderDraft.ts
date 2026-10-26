import { createCommerceOrderDraftRpcPort as createPort, type CommerceOrderDraftRpcClient as RpcClient } from "@openlup/platform/commerce/server";
import { createOrderDraftResponseSchema, type CreateOrderDraftRequest, type CreateOrderDraftResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceOrderDraftWritePort } from "../../../src/domains/commerce/ports.js";
import { createOrderDraftRpcArgs, type OrderDraftRpcArgs } from "../../domains/commerce/orderDraftRpcPayload.js";
export { ORDER_DRAFT_SUPERSEDE_RPC_NAME } from "@openlup/platform/commerce/server";
export type CommerceOrderDraftRpcClient = RpcClient<OrderDraftRpcArgs>;
export function createSupabaseCommerceOrderDraftPort(client: CommerceOrderDraftRpcClient): CommerceOrderDraftWritePort {
  return createPort<CreateOrderDraftRequest, CreateOrderDraftResponse, OrderDraftRpcArgs>(client, {
    createOrderDraftRpcArgs, responseSchema: createOrderDraftResponseSchema,
  });
}
