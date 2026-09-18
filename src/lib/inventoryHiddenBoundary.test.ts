import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const migration = read("supabase/migrations/20260605113000_inventory_phase1_hidden_control_plane.sql");
const probe = read("docs/sql/inventory_phase1_rehearsal_probe.sql");

describe("inventory hidden boundary", () => {
  it("adds the hidden inventory control-plane tables and service-role RPCs", () => {
    for (const required of [
      "CREATE TABLE IF NOT EXISTS public.inventory_locations",
      "CREATE TABLE IF NOT EXISTS public.inventory_lots",
      "CREATE TABLE IF NOT EXISTS public.inventory_balances",
      "CREATE TABLE IF NOT EXISTS public.inventory_stock_movements",
      "CREATE TABLE IF NOT EXISTS public.inventory_reservations",
      "CREATE TABLE IF NOT EXISTS public.inventory_supply_plans",
      "CREATE OR REPLACE FUNCTION public.inventory_reserve_order",
      "CREATE OR REPLACE FUNCTION public.inventory_consume_reservation_for_fulfillment",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("keeps inventory RPCs service-role-only and hidden from providers", () => {
    expect(migration).toContain("TO service_role");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).not.toMatch(/\bstripe\b|\badyen\b|\bdhl\b|\binpost\b/i);
  });

  it("guards against oversell and public RPC exposure in the SQL probe", () => {
    for (const required of [
      "inventory_probe_oversell_not_blocked",
      "inventory_probe_rpc_publicly_exposed",
      "ROLLBACK",
    ]) {
      expect(probe).toContain(required);
    }
  });

  it("keeps hidden inventory routes out of the current production UI", () => {
    const uiFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      join(repoRoot, "src/App.tsx"),
      join(repoRoot, "src/main.tsx"),
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
