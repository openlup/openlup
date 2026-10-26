import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountReadFacade, CustomerAccountReadModelError, customerAccountReadFailureDetails,
  logCustomerAccountReadFailure, withCustomerAccountReadStage } from "../../src/account-support/index.js";

afterEach(() => vi.restoreAllMocks());

describe("unchanged account read diagnostics witness", () => {
  it("wraps the original cause and stage, and retains success identity", async () => {
    const cause = Object.assign(new Error("permission denied for table orders"), { code: "42501" });
    await expect(withCustomerAccountReadStage("account_aggregate", async () => { throw cause; }))
      .rejects.toMatchObject({ name: "CustomerAccountReadModelError", stage: "account_aggregate", cause });
    const value = { ownerRevision: "original" };
    expect(await withCustomerAccountReadStage("account_aggregate", async () => value)).toBe(value);
  });
  it("does not double-wrap staged failures", async () => {
    const staged = new CustomerAccountReadModelError("account_aggregate", new Error("read unavailable"));
    await expect(withCustomerAccountReadStage("account_aggregate", async () => { throw staged; })).rejects.toBe(staged);
  });
  it("returns the exact safe transport failure details", () => {
    const cause = Object.assign(new Error("permission denied"), { code: "42501", privateField: "synthetic-private-value" });
    expect(customerAccountReadFailureDetails(new CustomerAccountReadModelError("account_aggregate", cause)))
      .toEqual({ reason: "read_model_failed", stage: "account_aggregate", providerCode: "42501" });
    expect(customerAccountReadFailureDetails(new Error("plain failure"))).toEqual({ reason: "read_model_failed", stage: "unknown" });
  });
  it("keeps the diagnostic allowlist and original log shape", () => {
    const error = Object.assign(new Error("permission denied for table orders"), {
      code: " 42501 ", details: "policy blocked", hint: " ", privateField: "synthetic-private-value",
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logCustomerAccountReadFailure(new CustomerAccountReadModelError("account_aggregate", error));
    expect(spy.mock.calls).toEqual([["[customer-account] read model failed:", JSON.stringify({
      stage: "account_aggregate", cause: { name: "Error", message: error.message, code: "42501", details: "policy blocked" },
    })]]);
    logCustomerAccountReadFailure({ code: "x".repeat(301), message: "  bounded  ", hidden: true });
    expect(spy.mock.calls[1]).toEqual(["[customer-account] read failed:", JSON.stringify({
      cause: { type: "object", code: "x".repeat(300), message: "bounded" },
    })]);
    for (const value of [null, [], 42]) {
      logCustomerAccountReadFailure(value);
      expect(spy.mock.lastCall).toEqual(["[customer-account] read failed:", JSON.stringify({ cause: { type: typeof value } })]);
    }
  });
});

it("delegates all reads once with receivers, arguments and result identity intact", async () => {
  const account = { revision: "account-original", getAccount: vi.fn(function (this: { revision: string }, userId: string) {
    return Promise.resolve({ revision: this.revision, userId });
  }) };
  const list = { orders: [{ frozenTotal: 2301, currency: "XXX" }] }, detail = { orderId: "order-distinct", revision: "frozen" };
  const orders = { listOrders: vi.fn(async () => list), getOrderDetail: vi.fn(async () => detail) };
  const facade = createAccountReadFacade({ account, orders });
  expect(await facade.getAccount("principal-a")).toEqual({ revision: "account-original", userId: "principal-a" });
  const input = { limit: 17 };
  expect(await facade.listOrders("principal-b", input)).toBe(list);
  expect(orders.listOrders.mock.calls).toEqual([["principal-b", input]]);
  expect(await facade.getOrderDetail("principal-c", "order-distinct")).toBe(detail);
  expect(orders.getOrderDetail.mock.calls).toEqual([["principal-c", "order-distinct"]]);
  expect(account.getAccount).toHaveBeenCalledExactlyOnceWith("principal-a");
});

it("preserves nulls and original thrown refusals for every read", async () => {
  const failure = Object.assign(new Error("UPSTREAM_UNAVAILABLE"), { code: "UPSTREAM_UNAVAILABLE" });
  for (const fail of [false, true]) {
    const result = async () => { if (fail) throw failure; return null; };
    const facade = createAccountReadFacade({ account: { getAccount: result }, orders: { listOrders: result, getOrderDetail: result } });
    for (const run of [() => facade.getAccount("a"), () => facade.listOrders("b", { limit: 4 }), () => facade.getOrderDetail("c", "o")]) {
      if (fail) await expect(run()).rejects.toBe(failure);
      else expect(await run()).toBeNull();
    }
  }
});
