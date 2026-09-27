import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { managedFunction, managedTable } from "../test/managedSchema.js";

const repoRoot = process.cwd();
const tableNames = ["inventory_locations", "inventory_lots", "inventory_balances", "inventory_stock_movements", "inventory_reservations", "inventory_supply_plans"];
const functionNames = ["inventory_reserve_order", "inventory_consume_reservation_for_fulfillment"];
const migration = [...tableNames.map(managedTable), ...functionNames.map(managedFunction)].join("\n");


describe("inventory hidden boundary", () => {
  it("adds the hidden inventory control-plane tables and service-role RPCs", () => {
    for (const required of [
      "CREATE TABLE public.inventory_locations",
      "CREATE TABLE public.inventory_lots",
      "CREATE TABLE public.inventory_balances",
      "CREATE TABLE public.inventory_stock_movements",
      "CREATE TABLE public.inventory_reservations",
      "CREATE TABLE public.inventory_supply_plans",
      "CREATE FUNCTION public.inventory_reserve_order",
      "CREATE FUNCTION public.inventory_consume_reservation_for_fulfillment",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("keeps inventory RPCs explicit service-role declarations and provider-free bodies", () => {
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
    expect(migration).not.toMatch(/\bstripe\b|\badyen\b|\bdhl\b|\binpost\b/i);
  });

  it("guards against oversell and public RPC exposure in the SQL probe", () => {
    const probe = read("docs/sql/inventory_phase1_rehearsal_probe.sql");
    for (const required of [
      "inventory_probe_oversell_not_blocked",
      "inventory_probe_rpc_publicly_exposed",
      "ROLLBACK",
    ]) {
      expect(probe).toContain(required);
    }
  });

  it("keeps hidden inventory routes out of the published browser UI", () => {
    const uiFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      join(repoRoot, "src/public-reference/App.tsx"),
      join(repoRoot, "src/public-reference/main.tsx"),
    ]
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !/\.(test|spec)\./.test(file));

    const violations = uiFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [/\/api\/bff\/admin\/inventory\//, /inventoryClient/, /AdminInventory/i]
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativePath(file)} -> ${pattern}`);
    });

    expect(violations).toEqual([]);
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
