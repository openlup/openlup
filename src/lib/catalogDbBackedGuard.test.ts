import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture lint guard for the managed catalog adapter.
 *
 * The strict overlay composes the mounted discovery routes. This guard keeps the
 * managed request-scoped adapter explicit about its factory and dependency seam.
 */

const repoRoot = process.cwd();
const portPath = join(repoRoot, "server", "adapters", "supabase", "catalogRead.ts");

describe("managed catalog adapter", () => {
  it("ships the canonical managed catalog adapter", () => {
    expect(existsSync(portPath)).toBe(true);
  });

  it("exports the createSupabaseCatalogReadPort factory", () => {
    const source = readFileSync(portPath, "utf8");
    expect(source).toMatch(/export function createSupabaseCatalogReadPort/);
  });

  it("requires a Supabase client as the dependency", () => {
    const source = readFileSync(portPath, "utf8");
    expect(source).toMatch(/SupabaseCatalogReadPortDeps/);
    expect(source).toMatch(/client:\s*SupabaseClient/);
  });

  it("implements the CatalogReadPort contract", () => {
    const source = readFileSync(portPath, "utf8");
    expect(source).toMatch(/CatalogReadPort/);
    expect(source).toMatch(/listProducts\(\)/);
    expect(source).toMatch(/getProductBySlug/);
    expect(source).toMatch(/listAllergens\(\)/);
  });
});
