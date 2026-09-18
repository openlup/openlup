import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Auth OSS-extraction boundary. Guarantees the generic auth core
// (src/domains/auth + server/domains/auth) is a self-contained copy-unit free of
// Supabase, secrets, and vendor adapters, and that openlup's customer-auth
// session code depends only on the provider-agnostic port (the Supabase calls
// live solely in the customer auth adapter). Mirrors the other *Boundary tests.
//
// NOTE: this is scoped to CUSTOMER auth. Admin auth (src/lib/useAuth.tsx) is a
// separate surface and intentionally keeps its own Supabase coupling.

const repoRoot = process.cwd();

function readFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? readFiles(full) : [full];
  });
}

function rel(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}

const CORE_AUTH_DIRS = ["src/domains/auth", "server/domains/auth"];

const FORBIDDEN_IN_CORE: Array<[string, RegExp]> = [
  ["supabase SDK import", /from ["'][^"']*@supabase\//],
  ["supabase integration import", /from ["'][^"']*integrations\/supabase/],
  ["server infra import", /from ["'][^"']*(?:\.\.\/)*(?:server\/)?infra\//],
  ["server adapters import", /from ["'][^"']*(?:\.\.\/)*(?:server\/)?adapters\//],
  ["runtime secret/env read", /\b(?:process\.env|import\.meta\.env)\b/],
];

describe("auth OSS-extraction boundary", () => {
  it("keeps the generic auth core free of Supabase, secrets, infra, and adapters", () => {
    const files = CORE_AUTH_DIRS.flatMap((dir) => readFiles(join(repoRoot, dir)))
      .map(rel)
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));

    // Sanity: the core actually exists (so this test can't silently pass empty).
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((path) => {
      const source = readFileSync(join(repoRoot, path), "utf8");
      return FORBIDDEN_IN_CORE.filter(([, pattern]) => pattern.test(source)).map(
        ([label]) => `${path} -> ${label}`,
      );
    });

    expect(violations).toEqual([]);
  });

  it("routes customer-auth session code through the port (no direct Supabase coupling)", () => {
    const portConsumers = ["src/lib/useCustomerAuth.tsx", "src/lib/customerAuthContext.ts"];
    const violations = portConsumers.flatMap((path) => {
      const source = readFileSync(join(repoRoot, path), "utf8");
      return [
        ["supabase SDK import", /from ["'][^"']*@supabase\//],
        ["direct customer client import", /integrations\/supabase\/customerClient/],
        ["direct supabase.auth call", /supabase\.auth\./],
      ]
        .filter(([, pattern]) => (pattern as RegExp).test(source))
        .map(([label]) => `${path} -> ${label as string}`);
    });

    expect(violations).toEqual([]);
  });

  it("confines customer-auth Supabase calls to the single adapter", () => {
    const adapter = "src/integrations/supabase/customerAuthPort.ts";
    expect(existsSync(join(repoRoot, adapter))).toBe(true);
    expect(/supabase\.auth\./.test(readFileSync(join(repoRoot, adapter), "utf8"))).toBe(true);
  });
});
