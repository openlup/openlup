import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitFunctionExecuteRoles, explicitTablePrivileges } from "../test/historicalBoundarySchema";

const repoRoot = process.cwd();
const tables = ["inventory_locations", "inventory_lots", "inventory_balances", "inventory_stock_movements", "inventory_reservations", "inventory_supply_plans"];
const functions = ["inventory_reserve_order", "inventory_consume_reservation_for_fulfillment"];
const migration = [...tables.map(currentTableStatements), ...functions.map(effectiveFunctionBody)].join("\n");

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

  it("keeps inventory RPCs service-role-only and hidden from providers", () => {
    for (const name of functions) for (const roles of explicitFunctionExecuteRoles(name).values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
    for (const table of tables) {
      expect(currentTableStatements(table)).toContain("ENABLE ROW LEVEL SECURITY");
      const roles = explicitTablePrivileges(table);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.get(role)?.size ?? 0).toBe(0);
    }
    expect(migration).not.toMatch(/net\.http_|Authorization: Basic/);
  });

  it("retains locked stock selection and active-lease oversell refusal", () => {
    const reserve = effectiveFunctionBody("inventory_reserve_order");
    expect(reserve).toContain("FOR UPDATE OF b");
    expect(reserve).toContain("r.status = 'reserved'");
    expect(reserve).toContain("r.expires_at IS NULL OR r.expires_at > now()");
    expect(reserve).toContain("inventory_reservation_insufficient_available_stock");
  });
  it("keeps hidden inventory routes out of the current production UI", () => {
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
