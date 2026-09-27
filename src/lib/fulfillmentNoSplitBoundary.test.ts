import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allMigrations, effectiveFunctionBody } from "../test/effectiveMigration";
const migration = ["commerce_guard_no_split_fulfillment_order", "commerce_guard_handoff_no_split"].map(effectiveFunctionBody).join("\n");
const preflightMigration = ["commerce_fulfillment_preflight_split_shipment", "commerce_fulfillment_order_reservation_location_count"].map(effectiveFunctionBody).join("\n");
const schema = allMigrations().map(({ content }) => content).join("\n");
const port = readFileSync("server/adapters/supabase/orderPaidFulfillmentPort.ts", "utf8");

describe("fulfillment no-split boundary", () => {
  it("rejects handoff for fulfillment orders reserved across multiple locations", () => {
    for (const required of [
      "commerce_guard_no_split_fulfillment_order",
      "count(DISTINCT ir.location_id)",
      "unnest(l.inventory_reservation_ids)",
      "split_shipment_unsupported",
      "NEW.status = 'handed_over'",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("wires the handoff refusal to the actual fulfillment status trigger", () => {
    expect(schema).toContain("CREATE TRIGGER trg_commerce_guard_handoff_no_split BEFORE UPDATE OF status ON public.commerce_fulfillment_orders FOR EACH ROW EXECUTE FUNCTION public.commerce_guard_handoff_no_split()");
  });

  it("detects the split at order granularity in the preflight, before any fulfillment row exists", () => {
    for (const required of [
      "commerce_fulfillment_preflight_split_shipment",
      "commerce_fulfillment_order_reservation_location_count",
      "count(DISTINCT ir.location_id)",
      "FROM public.inventory_reservations ir",
      "'splitRequired', true",
      "'fulfillment_exception'", // routes to an observable manual-review hold
    ]) {
      expect(preflightMigration).toContain(required);
    }
  });

  it("runs the split preflight BEFORE the create/label RPCs in the order-paid port", () => {
    // Use runtime statements (not the doc-comment that lists every RPC name) as
    // a source-order proxy for call-order: the preflight guard short-circuits
    // before the create / label rpc() calls in ensureFulfilledFromPaidOrder.
    const guardReturnAt = port.indexOf('if ("kind" in guard) return guard;');
    const createRpcAt = port.indexOf('client.rpc("commerce_fulfillment_create_order"');
    const labelRpcAt = port.indexOf('client.rpc("commerce_fulfillment_record_label_created"');
    expect(guardReturnAt).toBeGreaterThan(-1);
    expect(createRpcAt).toBeGreaterThan(-1);
    expect(labelRpcAt).toBeGreaterThan(-1);
    expect(guardReturnAt).toBeLessThan(createRpcAt);
    expect(guardReturnAt).toBeLessThan(labelRpcAt);
  });
});
