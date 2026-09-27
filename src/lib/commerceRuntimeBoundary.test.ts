import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { managedFunction, managedTable } from "../test/managedSchema";

const repoRoot = process.cwd();
const migration = managedFunction("commerce_finalize_order_for_checkout");

describe("hidden checkout runtime boundary", () => {
  it("keeps pet-aware order finalize isolated from payment and reservation writers", () => {
    const orders = managedTable("commerce_orders");
    expect(orders).toContain("pet_id uuid");
    expect(orders).toContain("FOREIGN KEY (pet_id) REFERENCES public.pets(id) ON DELETE SET NULL");
    for (const required of [
      "CREATE FUNCTION public.commerce_finalize_order_for_checkout",
      "GRANT ALL ON FUNCTION public.commerce_finalize_order_for_checkout",
      "TO service_role",
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\bSET NOT NULL\b/i);
    expect(migration).not.toMatch(/\bDROP TABLE\b|\bTRUNCATE\b|\bDELETE FROM public\.(testers|waitlist)\b/i);
    expect(migration).not.toMatch(/\bFROM public\.(testers|waitlist)\b|\bJOIN public\.(testers|waitlist)\b/i);
    expect(migration).not.toContain("commerce_payment_control_apply_result");
    expect(migration).not.toContain("inventory_reserve_order");
  });

  it("keeps hidden runtime mutations disabled by default", () => {
    const shared = read("server/bff/admin/commerce/shared.ts");
    expect(shared).toContain("COMMERCE_RUNTIME_MUTATIONS_ENABLED");
    expect(shared).toContain('=== "true"');
  });

  it("keeps hidden runtime routes out of the current production UI", () => {
    const uiFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      join(repoRoot, "src/public-reference/App.tsx"),
      join(repoRoot, "src/public-reference/main.tsx"),
      join(repoRoot, "src/public-reference/subscription-main.tsx"),
    ]
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !/\.(test|spec)\./.test(file));

    const violations = uiFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [
        /\/api\/bff\/admin\/commerce\/runtime\//,
        /startHiddenCheckoutRuntime/i,
        /commerceRuntime/i,
      ]
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
