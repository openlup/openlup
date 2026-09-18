import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import "./outboxOrderPaidFulfillmentPorts.js";

describe("order-paid fulfillment domain port", () => {
  it("stays a provider-neutral contract with no concrete persistence import", () => {
    const source = readFileSync(
      join(process.cwd(), "server/domains/commerce/outboxOrderPaidFulfillmentPorts.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/(?:import|export)[^;]+(?:supabase|postgres|server\/adapters)/i);
    expect(source).toContain("OrderPaidFulfillmentPort");
  });
});
