import { describe, expect, it } from "vitest";

import {
  adminCommerceOrderDetailRequestSchema,
  adminCommerceOrdersListRequestSchema,
} from "../../src/domains/commerce/omsContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../src/domains/commerce/types.js";
import { toolInputSchema } from "../_core/toolFromContract.js";
import { buildOmsReadTools } from "./tools.js";

const tools = buildOmsReadTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));

describe("buildOmsReadTools", () => {
  it("exposes exactly the read-only OMS support tools", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "oms__get_order_detail",
      "oms__search_orders",
    ]);
    for (const tool of tools) {
      expect(tool.httpMethod).toBe("GET");
      expect(tool.contractVersion).toBe(COMMERCE_CONTRACT_VERSION);
      expect(tool.name).toMatch(/^[a-z]+__[a-z_]+$/);
    }
  });

  it("derives schemas from the OMS contracts", () => {
    expect(byName.get("oms__search_orders")?.requestSchema).toBe(adminCommerceOrdersListRequestSchema);
    expect(byName.get("oms__search_orders")?.inputSchema).toEqual(
      toolInputSchema(adminCommerceOrdersListRequestSchema),
    );
    expect(byName.get("oms__get_order_detail")?.requestSchema).toBe(adminCommerceOrderDetailRequestSchema);
    expect(byName.get("oms__get_order_detail")?.inputSchema).toEqual(
      toolInputSchema(adminCommerceOrderDetailRequestSchema),
    );
  });
});
