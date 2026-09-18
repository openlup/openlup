import {
  OMS_CONTROL_PLANE_VERSION,
  omsControlPlaneActions,
  omsControlPlaneDetailResponseSchema,
  omsControlPlaneListResponseSchema,
  type CommerceOmsControlPlanePort,
  type OmsControlPlaneOrder,
} from "../../../src/domains/commerce/omsControlPlane.js";
import type { AdminOmsOrderListItem } from "../../../src/domains/commerce/omsContracts.js";
import type { CommerceOmsReadPort } from "../../../src/domains/commerce/omsPorts.js";

export function createSupabaseCommerceOmsControlPlanePort(
  managedPort: CommerceOmsReadPort,
): CommerceOmsControlPlanePort {
  return {
    async listOrders(request) {
      const result = await managedPort.listOrders({
        page: request.page,
        pageSize: request.pageSize,
        status: request.status,
        sort: "created_desc",
      });
      return omsControlPlaneListResponseSchema.parse({
        contractVersion: OMS_CONTROL_PLANE_VERSION,
        orders: result.orders.map(mapOrder),
        totalCount: result.totalCount,
        page: result.page,
        pageSize: result.pageSize,
      });
    },
    async getOrderDetail(request) {
      const result = await managedPort.getOrderDetail({ orderId: request.orderId });
      if (!result) return null;
      const operation = (type: string) => {
        if (type === "hold_created" || type === "hold_released") return type;
        if (type === "order_cancelled_manual") return "order_cancelled" as const;
        if (type === "order_marked_refunded") return "order_refunded" as const;
        return null;
      };
      return omsControlPlaneDetailResponseSchema.parse({
        contractVersion: OMS_CONTROL_PLANE_VERSION,
        order: mapOrder(result.order),
        holds: result.order.holds.map((hold) => ({
          id: hold.id,
          status: hold.status,
          reason: hold.reason,
          note: hold.note,
          createdAt: hold.createdAt,
          releasedAt: hold.releasedAt,
        })),
        operations: result.order.operations.flatMap((entry) => {
          const action = operation(entry.type);
          return action ? [{
            id: entry.id,
            action,
            holdId: entry.holdId,
            actorId: entry.actorUserId,
            occurredAt: entry.occurredAt,
          }] : [];
        }),
      });
    },
  };
}

function mapOrder(order: AdminOmsOrderListItem): OmsControlPlaneOrder {
  return {
    orderId: order.orderId,
    status: order.status,
    sourceKind: order.sourceKind ?? "storefront",
    sourceOrderRef: order.sourceOrderRef ?? null,
    money: order.total,
    shipmentStatus: order.fulfillmentStatus,
    activeHoldCount: order.activeHoldCount,
    activeHoldReasons: order.activeHoldReasons,
    actions: omsControlPlaneActions(order.status, order.activeHoldCount),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
