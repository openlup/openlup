import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";

const repoRoot = process.cwd();
const functions = ["commerce_fulfillment_create_order", "commerce_fulfillment_mark_handed_over", "commerce_fulfillment_record_label_created"];
const migration = [ ...["commerce_fulfillment_orders", "commerce_fulfillment_order_lines", "commerce_fulfillment_operations", "commerce_fulfillment_provider_attempts"].map(currentTableStatements), ...functions.map(effectiveFunctionBody)].join("\n");

describe("commerce fulfillment integration boundary", () => {
  it("adds fulfillment workflow persistence without duplicating provider tracking", () => {
    for (const required of [
      "CREATE TABLE public.commerce_fulfillment_orders",
      "CREATE TABLE public.commerce_fulfillment_order_lines",
      "CREATE TABLE public.commerce_fulfillment_operations",
      "CREATE TABLE public.commerce_fulfillment_provider_attempts",
      "CREATE FUNCTION public.commerce_fulfillment_create_order",
      "CREATE FUNCTION public.commerce_fulfillment_mark_handed_over",
      "INSERT INTO public.shipment_external_refs",
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toContain("CREATE TABLE public.shipment_external_refs");
    expect(migration).not.toContain("CREATE TABLE public.commerce_fulfillment_tracking");
  });

  it("keeps fulfillment RPCs service-role-only and provider-call-free", () => {
    for (const name of functions) for (const roles of explicitFunctionExecuteRoles(name).values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
    expect(`${migration}\n${read("server/domains/fulfillment/commerceFulfillmentHandlers.ts")}`).not.toMatch(
      /\bcreateDhlShipment\b|\bbookDhlCourier\b|\bdhl-create-shipment\b|\binpost\b/i,
    );
  });

  it("uses the existing canonical FulfillmentPort and does not create another provider port", () => {
    const fulfillmentFiles = [
      ...readFiles(join(repoRoot, "src/domains/fulfillment")),
      ...readFiles(join(repoRoot, "server/domains/fulfillment")),
    ].filter((file) => /\.(ts|tsx)$/.test(file));

    const duplicateInterfaces = fulfillmentFiles.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      if (relativePath(file) === "src/domains/fulfillment/commerceV2FulfillmentPort.ts") return [];
      return /\binterface\s+FulfillmentPort\b/.test(text) ? [relativePath(file)] : [];
    });

    expect(duplicateInterfaces).toEqual([]);
  });

  it("keeps label recording free of stock consumption and handoff replay guarded", () => {
    expect(effectiveFunctionBody("commerce_fulfillment_record_label_created")).not.toContain("inventory_consume_reservation_for_fulfillment");
    const handoff = effectiveFunctionBody("commerce_fulfillment_mark_handed_over");
    expect(handoff).toContain("inventory_consume_reservation_for_fulfillment");
    const replay = handoff.indexOf("IF v_fulfillment.status IN ('handed_over', 'in_transit', 'delivered') THEN");
    expect(replay).toBeGreaterThan(handoff.indexOf("FOR UPDATE"));
    expect(handoff.indexOf("'replayed', true")).toBeGreaterThan(replay);
    expect(handoff.indexOf("inventory_consume_reservation_for_fulfillment")).toBeGreaterThan(handoff.indexOf("'replayed', true"));
    expect(handoff).toContain("p_idempotency_key || ':' || v_reservation_id::text");
    expect(handoff).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
  });
});

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function readFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return readFiles(fullPath);
    return [fullPath];
  });
}

function relativePath(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}
