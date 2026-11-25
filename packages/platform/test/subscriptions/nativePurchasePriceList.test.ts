import { expect, it, vi } from "vitest";
import { resolveNativePurchasePriceList } from "../../src/subscriptions/nativePurchasePriceList.js";
import type { SubscriptionQueryExecutor } from "../../src/subscriptions/postgresRenewalStore.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const priceListId = "22222222-2222-4222-8222-222222222222";
const storedList = { id: priceListId, currency: "XXX" };
const pricedLine = { catalogFacts: { version: "catalog_facts_v2" }, unitPriceGross: { amountMinor: 110, currency: "XXX" } };

function derivedOrder(lines = [pricedLine]) {
  return { currency_code: "XXX", created_at: "2026-11-25T09:00:00.000Z", line_count: lines.length,
    quote: { quote: { lines } }, draft: { lines } };
}

it("keeps explicit subscription prices and legacy any prices in the same precedence query", async () => {
  const query = vi.fn<SubscriptionQueryExecutor["query"]>()
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [storedList] });
  await expect(resolveNativePurchasePriceList({ query }, orderId)).resolves.toEqual({ priceListId, currency: "XXX" });
  expect(query).toHaveBeenCalledTimes(2);
  const [sql, values] = query.mock.calls[1]!;
  expect(sql).toContain("price.mode IN (COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time'),'any')");
  expect(sql).toContain("ORDER BY (price.mode=COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time')) DESC,");
  expect(sql).toContain("price.min_qty DESC,price.id LIMIT 1");
  expect(values).toEqual([orderId]);
});

it.each([true, false])("requires the native verifier to accept the persisted amount (accepted: %s)", async accepted => {
  const order = derivedOrder();
  const query = vi.fn<SubscriptionQueryExecutor["query"]>()
    .mockResolvedValueOnce({ rows: [order] }).mockResolvedValueOnce({ rows: [{ id: accepted ? priceListId : null }] })
    .mockResolvedValue({ rows: [storedList] });
  await expect(resolveNativePurchasePriceList({ query }, orderId)).resolves.toEqual(accepted
    ? { priceListId, currency: "XXX" } : { priceListId: null, currency: null, reason: "missing" });
  expect(query).toHaveBeenCalledTimes(2);
  const [sql, values] = query.mock.calls[1]!;
  expect(sql).toContain("public.catalog_admission_derived_subscription_prices($1,$2,$3,$4)");
  expect(sql).toContain("verified.units[item.position::int] IS NOT NULL");
  expect(values).toEqual([order.currency_code, order.quote, order.draft, order.created_at]);
});

it("verifies a mixed draft's stored rows against the list bound by its derived rows", async () => {
  const query = vi.fn<SubscriptionQueryExecutor["query"]>()
    .mockResolvedValueOnce({ rows: [derivedOrder([pricedLine, { ...pricedLine, catalogFacts: { version: "catalog_facts_v1" } }])] })
    .mockResolvedValueOnce({ rows: [storedList] }).mockResolvedValueOnce({ rows: [storedList] });
  await expect(resolveNativePurchasePriceList({ query }, orderId)).resolves.toEqual({ priceListId, currency: "XXX" });
  const [sql, values] = query.mock.calls[2]!;
  expect(sql).toContain("IS DISTINCT FROM 'catalog_facts_v2'");
  expect(values).toEqual([orderId, priceListId]);
});
