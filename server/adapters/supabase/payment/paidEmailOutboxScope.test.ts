import { describe, expect, it } from "vitest";
import { readPaidEmailOutboxScope } from "./paidEmailOutboxScope.js";

describe("readPaidEmailOutboxScope", () => {
  it("uses the payment intent subscription when it is already linked", async () => {
    const client = fakeClient({
      commerce_payment_intents: [
        { id: "pi_1", order_id: "order-1", subscription_id: "subscription-1" },
      ],
      commerce_orders: [],
    });

    await expect(readPaidEmailOutboxScope(client, "pi_1")).resolves.toEqual({
      orderId: "order-1",
      subscriptionId: "subscription-1",
    });
    expect(client.calls).toEqual(["commerce_payment_intents:id=pi_1"]);
  });

  it("falls back to the order subscription when the intent row does not carry it", async () => {
    const client = fakeClient({
      commerce_payment_intents: [
        { id: "pi_2", order_id: "order-2", subscription_id: null },
      ],
      commerce_orders: [
        { id: "order-2", subscription_id: "subscription-2" },
      ],
    });

    await expect(readPaidEmailOutboxScope(client, "pi_2")).resolves.toEqual({
      orderId: "order-2",
      subscriptionId: "subscription-2",
    });
    expect(client.calls).toEqual([
      "commerce_payment_intents:id=pi_2",
      "commerce_orders:id=order-2",
    ]);
  });

  it("returns null when the payment intent cannot be resolved", async () => {
    await expect(readPaidEmailOutboxScope(fakeClient({
      commerce_payment_intents: [],
      commerce_orders: [],
    }), "missing")).resolves.toBeNull();
  });
});

function fakeClient(tables: Record<string, Record<string, unknown>[]>): {
  calls: string[];
  from(table: string): FakeQuery;
} {
  const calls: string[] = [];
  return {
    calls,
    from(table) {
      return new FakeQuery(table, tables[table] ?? [], calls);
    },
  };
}

class FakeQuery {
  private filters: Array<{ column: string; value: unknown }> = [];

  constructor(
    private readonly table: string,
    private readonly rows: Record<string, unknown>[],
    private readonly calls: string[],
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  async maybeSingle() {
    const label = this.filters.map(({ column, value }) => `${column}=${String(value)}`).join(",");
    this.calls.push(`${this.table}:${label}`);
    const data = this.rows.find((row) => this.filters.every(({ column, value }) => row[column] === value)) ?? null;
    return { data, error: null };
  }
}
