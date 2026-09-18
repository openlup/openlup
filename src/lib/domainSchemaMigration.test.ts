import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/20260529130000_domain_ecommerce_schema_shell.sql",
);
const anonGrantHardeningPath = join(
  process.cwd(),
  "supabase/migrations/20260529150000_domain_shell_revoke_anon.sql",
);

const sql = readFileSync(migrationPath, "utf8");
const anonGrantHardeningSql = readFileSync(anonGrantHardeningPath, "utf8");

const expectedTables = [
  "clients",
  "pets",
  "client_consents",
  "client_source_links",
  "catalog_products",
  "catalog_product_variants",
  "catalog_skus",
  "catalog_prices",
  "commerce_carts",
  "commerce_cart_items",
  "commerce_checkout_sessions",
  "commerce_orders",
  "commerce_order_items",
  "commerce_payments",
  "commerce_payment_events",
  "commerce_idempotency_keys",
];

function createdTables(): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z0-9_]+) \(/g)].map(
    (match) => match[1],
  );
}

describe("domain ecommerce schema shell migration", () => {
  it("creates exactly the DB-1 domain shell tables", () => {
    expect(createdTables()).toEqual(expectedTables);
  });

  it("keeps the migration additive and provider agnostic", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|FUNCTION|VIEW|TYPE)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE[\s\S]*?\bDROP\b/i);
    expect(sql).not.toMatch(/\bstripe\b/i);
  });

  it("enables RLS and only exposes admin-authenticated policies", () => {
    for (const table of expectedTables) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`CREATE POLICY "admin_all_${table}" ON public.${table}`);
    }

    expect(sql).not.toMatch(/CREATE POLICY[\s\S]*?\bTO anon\b/i);
    expect(sql).not.toMatch(/\bGRANT\b[\s\S]*?\bTO anon\b/i);
  });

  it("revokes default anon table grants in the follow-up hardening migration", () => {
    for (const table of expectedTables) {
      expect(anonGrantHardeningSql).toContain(`'${table}'`);
    }

    expect(anonGrantHardeningSql).toContain("REVOKE ALL ON TABLE public.%I FROM anon");
    expect(anonGrantHardeningSql).not.toMatch(/\bGRANT\b[\s\S]*?\bTO anon\b/i);
  });

  it("keeps the migration small enough for wave review", () => {
    expect(sql.trimEnd().split("\n").length).toBeLessThanOrEqual(300);
  });
});
