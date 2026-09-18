import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { createSupabasePersonalizationReadPort } from "./personalizationRead.js";

// Chainable fake: select/eq/in/limit return `this`; maybeSingle resolves the
// per-table single-row result; a bare `.limit()` (orders) resolves to a row array;
// awaiting the builder itself (the head/count query) resolves to `{ count }`.
function fakeClient(cfg: {
  tables?: Record<string, { data: unknown; error?: unknown }>;
  orders?: unknown[];
  count?: number;
}): SupabaseClient {
  return {
    from(table: string) {
      const single = cfg.tables?.[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        limit: () => Promise.resolve({ data: cfg.orders ?? [], error: null }),
        maybeSingle: () => Promise.resolve(single),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ count: cfg.count ?? 0, error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("supabase personalization read port", () => {
  it("resolveClientIdByAuthUser returns the linked client id or null", async () => {
    const hit = createSupabasePersonalizationReadPort(
      fakeClient({ tables: { clients: { data: { id: "c1" } } } }),
    );
    expect(await hit.resolveClientIdByAuthUser("uid")).toBe("c1");
    const miss = createSupabasePersonalizationReadPort(fakeClient({ tables: { clients: { data: null } } }));
    expect(await miss.resolveClientIdByAuthUser("uid")).toBeNull();
  });

  it("loadRow maps the dog columns (no owner), or null when absent", async () => {
    const port = createSupabasePersonalizationReadPort(
      fakeClient({
        tables: {
          customer_personalization: {
            data: { dog_cases: { genitive: "Reksia" }, dog_conf: "high" },
          },
        },
      }),
    );
    const row = await port.loadRow("c1");
    expect(row?.dogConf).toBe("high");
    expect(row?.dogCases).toEqual({ genitive: "Reksia" });
    expect(row).not.toHaveProperty("ownerCases");

    const empty = createSupabasePersonalizationReadPort(
      fakeClient({ tables: { customer_personalization: { data: null } } }),
    );
    expect(await empty.loadRow("c1")).toBeNull();
  });

  it("hasPaidOrder is true only when a paid-status order exists", async () => {
    const paid = createSupabasePersonalizationReadPort(fakeClient({ orders: [{ id: "o1" }] }));
    expect(await paid.hasPaidOrder("c1")).toBe(true);
    const none = createSupabasePersonalizationReadPort(fakeClient({ orders: [] }));
    expect(await none.hasPaidOrder("c1")).toBe(false);
  });

  it("countDogs returns the exact dog count (0 when none)", async () => {
    const many = createSupabasePersonalizationReadPort(fakeClient({ count: 3 }));
    expect(await many.countDogs("c1")).toBe(3);
    const zero = createSupabasePersonalizationReadPort(fakeClient({ count: 0 }));
    expect(await zero.countDogs("c1")).toBe(0);
  });
});
