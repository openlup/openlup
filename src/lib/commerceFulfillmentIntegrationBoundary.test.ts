import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const migration = read("supabase/migrations/20260605123000_commerce_fulfillment_integration_control_plane.sql");
const probe = read("docs/sql/commerce_fulfillment_integration_rehearsal_probe.sql");

describe("commerce fulfillment integration boundary", () => {
  it("adds fulfillment workflow persistence without duplicating provider tracking", () => {
    for (const required of [
      "CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_orders",
      "CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_order_lines",
      "CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_operations",
      "CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_provider_attempts",
      "CREATE OR REPLACE FUNCTION public.commerce_fulfillment_create_order",
      "CREATE OR REPLACE FUNCTION public.commerce_fulfillment_mark_handed_over",
      "INSERT INTO public.shipment_external_refs",
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toContain("CREATE TABLE IF NOT EXISTS public.shipment_external_refs");
    expect(migration).not.toContain("CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_tracking");
  });

  it("keeps fulfillment RPCs service-role-only and provider-call-free", () => {
    expect(migration).toContain("TO service_role");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
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

  it("rehearses create, idempotency, label-without-consume, and handoff consume-once", () => {
    for (const required of [
      "commerce_fulfillment_probe_create_replay_failed",
      "commerce_fulfillment_probe_expected_failed_payment_rejection",
      "commerce_fulfillment_probe_expected_no_reservation_rejection",
      "commerce_fulfillment_probe_label_consumed_inventory",
      "commerce_fulfillment_probe_double_consume",
      "ROLLBACK",
    ]) {
      expect(probe).toContain(required);
    }
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
