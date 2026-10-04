import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges } from "../test/historicalBoundarySchema";

// These ledgers back the current checkout/account boundary. An original DB-1
// table inventory or migration line count does not prove their installed safety.
const ledgers = ["commerce_carts", "commerce_cart_items", "commerce_checkout_sessions", "commerce_orders", "commerce_order_items", "commerce_idempotency_keys"];

describe("current core commerce ledger boundaries", () => {
  it("retains RLS and no explicit anonymous or authenticated direct mutation grant", () => {
    for (const table of ledgers) {
      expect(currentTableStatements(table)).toContain("ENABLE ROW LEVEL SECURITY");
      const roles = explicitTablePrivileges(table);
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect(roles.get(role)?.has(privilege) ?? false, `${table}: ${role} ${privilege}`).toBe(false);
        }
      }
    }
  });

  it("retains order-item ownership and scoped idempotency identity", () => {
    expect(currentTableStatements("commerce_order_items")).toContain("FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE CASCADE");
    expect(currentTableStatements("commerce_idempotency_keys")).toContain("UNIQUE (scope, idempotency_key)");
  });
});
