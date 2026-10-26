import { createManagedCommerceRuntimeOrderPort as createPort } from "@openlup/platform/commerce/server";
import { startHiddenCheckoutRuntimeResponseSchema, type StartHiddenCheckoutRuntimeRequest } from "../../../../src/domains/commerce/runtimeContracts.js";
import type { CommerceCheckoutRuntimeOrderPort, FinalizedCheckoutOrder } from "../../../../src/domains/commerce/runtimePorts.js";
import { createOrderDraftSnapshotFromQuoteSnapshot } from "../../../../src/domains/commerce/orderDraftSnapshotContracts.js";
export { mapCommerceFinalizeRpcError as mapRpcError } from "@openlup/platform/commerce/server";
export type { ManagedCommerceRuntimeClient } from "@openlup/platform/commerce/server";
import type { ManagedCommerceRuntimeClient } from "@openlup/platform/commerce/server";
export function createManagedCommerceRuntimeOrderPort(client: ManagedCommerceRuntimeClient): CommerceCheckoutRuntimeOrderPort {
  return createPort<StartHiddenCheckoutRuntimeRequest, FinalizedCheckoutOrder>(client, {
    responseEnvelopeSchema: startHiddenCheckoutRuntimeResponseSchema.pick({ contractVersion: true }).passthrough(),
    finalizeArgs: (request) => {
      const orderId = request.orderDraft.orderId.replace(/^order_/, "");
      return {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: orderId,
        p_mode: request.mode,
        p_client_id: request.clientId,
        p_shipping_address_id: request.shippingAddressId,
        p_pet_id: request.petId ?? null,
        p_quote_snapshot: request.orderDraft.quoteSnapshot,
        p_order_draft_snapshot: createOrderDraftSnapshotFromQuoteSnapshot(
          request.orderDraft.quoteSnapshot,
        ),
        p_metadata: {
          ...request.metadata,
          source: "commerce.runtime.hidden.v0",
        },
      };
    },
  });
}
