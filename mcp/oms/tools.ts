import {
  adminCommerceOrderDetailRequestSchema,
  adminCommerceOrdersListRequestSchema,
} from "../../src/domains/commerce/omsContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../src/domains/commerce/types.js";
import { toolInputSchema, type McpToolDefinition } from "../_core/toolFromContract.js";

const OMS_BFF_BASE = "/api/bff/admin/commerce/orders";

export function buildOmsReadTools(): McpToolDefinition[] {
  return [
    {
      name: "oms__search_orders",
      description:
        "Search the admin OMS queue by order number/id, customer id/email/phone/name, statuses, date range, and pagination. Read-only support surface.",
      path: OMS_BFF_BASE,
      httpMethod: "GET",
      contractVersion: COMMERCE_CONTRACT_VERSION,
      requestSchema: adminCommerceOrdersListRequestSchema,
      inputSchema: toolInputSchema(adminCommerceOrdersListRequestSchema),
    },
    {
      name: "oms__get_order_detail",
      description:
        "Fetch a single OMS order detail with customer, pet, payment, fulfillment, holds, operations, accounting, and communication context. Read-only.",
      path: `${OMS_BFF_BASE}/detail`,
      httpMethod: "GET",
      contractVersion: COMMERCE_CONTRACT_VERSION,
      requestSchema: adminCommerceOrderDetailRequestSchema,
      inputSchema: toolInputSchema(adminCommerceOrderDetailRequestSchema),
    },
  ];
}
