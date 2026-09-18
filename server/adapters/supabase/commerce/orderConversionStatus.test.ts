import { describe, expect, it } from "vitest";
import { createSupabaseOrderConversionStatusPort } from "./orderConversionStatus.js";

// A tiny chainable fake of the Supabase query builder: select/eq/limit return
// `this`, maybeSingle resolves the queued row for the table.
function fakeClient(rows: Record<string, { data: unknown; error: { message?: string } | null }>) {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(rows[table] ?? { data: null, error: null }),
      };
      return builder;
    },
  };
}

const signal = new AbortController().signal;

describe("createSupabaseOrderConversionStatusPort", () => {
  it("treats a still-open unpaid draft as NOT converted", async () => {
    const port = createSupabaseOrderConversionStatusPort(
      fakeClient({
        commerce_orders: { data: { status: "draft" }, error: null },
        commerce_payments: { data: null, error: null },
      }),
    );
    expect(await port.isConverted("o1", signal)).toBe(false);
  });

  it("treats a draft with a payment row as converted", async () => {
    const port = createSupabaseOrderConversionStatusPort(
      fakeClient({
        commerce_orders: { data: { status: "draft" }, error: null },
        commerce_payments: { data: { order_id: "o1" }, error: null },
      }),
    );
    expect(await port.isConverted("o1", signal)).toBe(true);
  });

  it("treats a non-draft (paid) order as converted without reading payments", async () => {
    const port = createSupabaseOrderConversionStatusPort(
      fakeClient({ commerce_orders: { data: { status: "paid" }, error: null } }),
    );
    expect(await port.isConverted("o1", signal)).toBe(true);
  });

  it("treats a missing order row as converted (skip safely)", async () => {
    const port = createSupabaseOrderConversionStatusPort(
      fakeClient({ commerce_orders: { data: null, error: null } }),
    );
    expect(await port.isConverted("o1", signal)).toBe(true);
  });

  it("throws on a read error", async () => {
    const port = createSupabaseOrderConversionStatusPort(
      fakeClient({ commerce_orders: { data: null, error: { message: "boom" } } }),
    );
    await expect(port.isConverted("o1", signal)).rejects.toThrow("outbox_conversion_order_read_failed");
  });
});
