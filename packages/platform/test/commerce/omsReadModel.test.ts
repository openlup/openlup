import { createManagedCommerceOmsPort } from "../../src/commerce/adapters/managed/commerceOmsPort.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { buildOmsOrderDetailResponse, buildOmsOrderListResponse } from "../../src/commerce/model/omsReadModel.js";
import { adminCommerceOrderDetailResponseSchema, omsOrderDetailSchema } from "../../src/commerce/oms/omsContracts.js";
import { getCommerceOmsOrderDetail, listCommerceOmsOrders } from "../../src/commerce/adapters/managed/oms/readQueries.js";
import type { OmsOrderRow, CommerceOmsStore, ManagedQueryBuilder, ManagedQueryResult } from "../../src/commerce/contracts/index.js";
import { FakeOmsClient } from "./managedReadQueriesTestKit.js";
import { ORDER_A } from "./managedReadQueries.fixtures.js";
const order = ORDER_A as OmsOrderRow;
const detailInput = { order, paymentIntent: null, paymentAttempts: [], paymentTransitions: [], holds: [], operations: [], subscriptionCycleStatus: null };
describe("neutral OMS read-model composition", () => {
  it("returns an unprojected row without private identity or provider assumptions", () => {
    const detail = buildOmsOrderDetailResponse(detailInput);
    expect(detail.order).toMatchObject({ orderId: order.id, customer: null, providerOpsStatus: "none", providerOpsSla: null, providerOrderId: null, paymentStatus: "not_started", attentionReason: "payment_required" });
    expect(Object.keys(detail.order)).not.toContain("exampleExtension");
    expect(detail.order.fulfillmentHealth).toEqual({ healthStatus: "ok", attentionReasons: [], oldestAgeSeconds: null, opaqueIds: { orderId: order.id, fulfillmentOrderId: null, outboxEventId: null, dispatchRefFulfillmentOrderId: null, latestEvidenceFulfillmentOrderId: null } });
    const list = buildOmsOrderListResponse({ orders: [order], paymentIntents: [], activeHoldCounts: {}, totalCount: 1, page: 1, pageSize: 25 });
    expect(list.orders[0]).toMatchObject({ orderId: order.id, attentionReason: detail.order.attentionReason, nextAction: detail.order.nextAction });
    expect(list.summaryTotals.gmv).toEqual({ amountMinor: 0, currency: "XXX" });
  });
  it("preserves opaque host fields and provider facts through the injected final schema", () => {
    const bound = adminCommerceOrderDetailResponseSchema.extend({ order: omsOrderDetailSchema.extend({ exampleExtension: z.object({ token: z.string() }).strict() }) });
    const result = buildOmsOrderDetailResponse({ ...detailInput, projections: { providerOps: () => ({ status: "example_stage", sla: null, providerOrderId: "example-provider-order" }), detailFields: () => ({ exampleExtension: { token: "example" } }), parseDetail: value => bound.parse(value) } });
    expect(bound.parse(result).order.exampleExtension).toEqual({ token: "example" });
    expect(result.order.providerOpsStatus).toBe("example_stage");
  });
  it("hydrates a neutral managed order without invoking any provider projection or lifecycle writer", async () => {
    const store = new FakeOmsClient({ rpcData: {}, rows: { commerce_orders: [order] } });
    const detail = await getCommerceOmsOrderDetail(store, { orderId: order.id });
    expect(detail?.order.orderId).toBe(order.id);
    expect(store.rpcCalls).toEqual([{ functionName: "commerce_oms_resolve_delivery_contact_v1", args: { p_order_id: order.id } }]);
    expect(store.tablesRead).not.toContain("inbound_provider_events");
    expect(store.tablesRead).not.toContain("fulfillment_provider_stock_current");
  });
});

// Keep this client literal limited to the public structural contract. The usual
// fake builder has extra methods and can hide an undeclared required capability.
const declaredQueryMethods = ["select", "order", "eq", "is", "in", "gte", "lte", "ilike", "insert", "update", "range", "maybeSingle", "then"] as const;
class DeclaredOmsStore implements CommerceOmsStore {
  readonly queries: ManagedQueryBuilder[] = [];
  async rpc(functionName: string) {
    return { data: functionName === "commerce_oms_admin_list_queue"
      ? { orderIds: [order.id], totalCount: 1 }
      : { resolutionVersion: 1, scope: "missing", baseline: null, contact: null, contactDigest: null }, error: null };
  }
  query(table: string): ManagedQueryBuilder {
    const rows = table === "commerce_orders" ? [order] : [];
    const result: ManagedQueryResult = { data: rows, error: null };
    const query: ManagedQueryBuilder = {
      select() { return query; }, order() { return query; }, eq() { return query; }, is() { return query; }, in() { return query; },
      gte() { return query; }, lte() { return query; }, ilike() { return query; },
      insert() { return query; }, update() { return query; },
      range: async () => result,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then(onfulfilled, onrejected) { return Promise.resolve(result).then(onfulfilled, onrejected); },
    };
    this.queries.push(query);
    return query;
  }
}
it.each(["list", "detail"] as const)("hydrates %s using exactly the declared query capability", async view => {
  expectTypeOf<keyof ManagedQueryBuilder>().toEqualTypeOf<typeof declaredQueryMethods[number]>();
  const store = new DeclaredOmsStore();
  const queries = store.queries;
  if (view === "list") expect((await listCommerceOmsOrders(store, { page: 1, pageSize: 25, sort: "created_desc" })).orders[0]?.orderId).toBe(order.id);
  else expect((await getCommerceOmsOrderDetail(store, { orderId: order.id }))?.order.orderId).toBe(order.id);
  for (const query of queries) expect(Object.keys(query).sort()).toEqual([...declaredQueryMethods].sort());
});

it.each(["list", "detail"] as const)("hydrates %s through the public adapter factory with the declared class client", async view => {
  const store = new DeclaredOmsStore();
  const port = createManagedCommerceOmsPort(store, { queries: store });
  if (view === "list") expect((await port.listOrders({ page: 1, pageSize: 25, sort: "created_desc" })).orders[0]?.orderId).toBe(order.id);
  else expect((await port.getOrderDetail({ orderId: order.id }))?.order.orderId).toBe(order.id);
  for (const query of store.queries) expect(Object.keys(query).sort()).toEqual([...declaredQueryMethods].sort());
});
