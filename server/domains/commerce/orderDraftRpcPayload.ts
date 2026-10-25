import { createOrderDraftRpcPayload } from "@openlup/platform/commerce/server";
import { createQuoteResponseSchema } from "../../../src/domains/commerce/contracts.js";
import { createOrderDraftSnapshotFromQuoteSnapshot, orderDraftSnapshotSchema } from "../../../src/domains/commerce/orderDraftSnapshotContracts.js";
export { ORDER_DRAFT_RPC_NAME } from "@openlup/platform/commerce/server";
export { ORDER_DRAFT_SNAPSHOT_SOURCE } from "../../../src/domains/commerce/orderDraftSnapshotContracts.js";
export const { orderDraftRpcArgsSchema, createOrderDraftRpcArgs } = createOrderDraftRpcPayload({
  quoteSchema: createQuoteResponseSchema, draftSchema: orderDraftSnapshotSchema,
  createSnapshot: createOrderDraftSnapshotFromQuoteSnapshot,
});
export type OrderDraftRpcArgs = ReturnType<typeof createOrderDraftRpcArgs>;
