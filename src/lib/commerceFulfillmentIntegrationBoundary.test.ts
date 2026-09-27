import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { allMigrations } from "../test/effectiveMigration.js";
import { managedFunction, managedTable } from "../test/managedSchema.js";

const repoRoot = process.cwd();
const tableNames = ["commerce_fulfillment_orders", "commerce_fulfillment_order_lines", "commerce_fulfillment_operations", "commerce_fulfillment_provider_attempts"];
const functionNames = ["commerce_fulfillment_create_order", "commerce_fulfillment_mark_handed_over", "commerce_fulfillment_record_label_created"];
const migration = [...tableNames.map(managedTable), ...functionNames.map(managedFunction)].join("\n");


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
    const schema = allMigrations().map(({ content }) => content).join("\n");
    expect([...schema.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?public\.shipment_external_refs\b/gim)]).toHaveLength(1);
    expect(schema).not.toMatch(/^CREATE TABLE (?:IF NOT EXISTS )?public\.commerce_fulfillment_tracking\b/im);
  });

  it("keeps fulfillment RPCs explicit service-role declarations and provider-call-free bodies", () => {
    // Dump ACL text is not an effective-access proof; role-taking pgTAP owns refusal.
    for (const name of functionNames) {
      const declaration = managedFunction(name);
      expect(declaration).toMatch(new RegExp(
        `GRANT (?:ALL|EXECUTE) ON FUNCTION public\\.${name}\\([^;]*\\) TO service_role;`,
      ));
      expect(declaration).toContain(`REVOKE ALL ON FUNCTION public.${name}`);
      expect(declaration).toContain("FROM PUBLIC;");
      expect(declaration).not.toMatch(/GRANT [^;]+ TO (?:anon|authenticated|PUBLIC);/);
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

  it("rehearses create, idempotency, label-without-consume, and handoff consume-once", () => {
    const probe = read("docs/sql/commerce_fulfillment_integration_rehearsal_probe.sql");
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
