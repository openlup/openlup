import { describe, expect, it } from "vitest";
import { FakeOmsClient } from "./readQueriesTestKit.js";
import type { SupabaseQueryBuilder } from "./types.js";

describe("FakeOmsClient", () => {
  it("supports Supabase is-null filters before maybeSingle", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {
        accounting_invoices: [
          { id: "invoice-base", order_id: "order-1", correction_of_invoice_id: null },
          { id: "invoice-correction", order_id: "order-1", correction_of_invoice_id: "invoice-base" },
        ],
      },
    });

    const result = client
      .from("accounting_invoices")
      .select("id, order_id")
      .eq("order_id", "order-1");
    const narrowed = await filterIs(result, "correction_of_invoice_id", null).maybeSingle();

    expect(narrowed.error).toBeNull();
    expect(narrowed.data).toEqual({ id: "invoice-base", order_id: "order-1", correction_of_invoice_id: null });
    expect(client.filters).toContainEqual({
      table: "accounting_invoices",
      kind: "is",
      column: "correction_of_invoice_id",
      value: null,
    });
  });

  it("simulates maybeSingle errors when more than one row matches", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {
        accounting_invoices: [
          { id: "invoice-a", order_id: "order-1" },
          { id: "invoice-b", order_id: "order-1" },
        ],
      },
    });

    const result = await client
      .from("accounting_invoices")
      .select("id, order_id")
      .eq("order_id", "order-1")
      .maybeSingle();

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({
      code: "PGRST116",
      details: "Results contain more than 1 row",
    });
  });

  it("simulates select-specific Supabase errors for OMS read-query tests", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: { shipment_external_refs: [{ order_id: "order-1", provider_tracking_id: "TRACK-1", active: true }] },
      selectErrors: [
        {
          table: "shipment_external_refs",
          whenColumnsInclude: "tracking_url",
          error: { code: "42703", message: "column shipment_external_refs.tracking_url does not exist" },
        },
      ],
    });

    const failing = await client
      .from("shipment_external_refs")
      .select("order_id, provider_tracking_id, tracking_url")
      .eq("order_id", "order-1");
    const fallback = await client
      .from("shipment_external_refs")
      .select("order_id, provider_tracking_id, active")
      .eq("order_id", "order-1");

    expect(failing.error?.code).toBe("42703");
    expect(fallback.error).toBeNull();
    expect(fallback.data).toEqual([
      { order_id: "order-1", provider_tracking_id: "TRACK-1", active: true },
    ]);
  });
});

type SupabaseQueryBuilderWithIs = SupabaseQueryBuilder & {
  is(column: string, value: unknown): SupabaseQueryBuilder;
};

function filterIs(query: SupabaseQueryBuilder, column: string, value: unknown): SupabaseQueryBuilder {
  return (query as SupabaseQueryBuilderWithIs).is(column, value);
}
