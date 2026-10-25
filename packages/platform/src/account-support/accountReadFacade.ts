import type { AccountReadPort } from "./contracts/index.js";

/** Pure delegation to selected owner reads. Authorization, defaults, diagnostics,
 * private fields and transport refusal mapping remain with the injected owners.
 */
export function createAccountReadFacade<Account, OrderList, OrderDetail>(
  ports: { account: Pick<AccountReadPort<Account, OrderList, OrderDetail>, "getAccount">;
    orders: Pick<AccountReadPort<Account, OrderList, OrderDetail>, "listOrders" | "getOrderDetail"> },
): AccountReadPort<Account, OrderList, OrderDetail> {
  return {
    getAccount(userId) { return ports.account.getAccount(userId); },
    listOrders(userId, input) { return ports.orders.listOrders(userId, input); },
    getOrderDetail(userId, orderId) { return ports.orders.getOrderDetail(userId, orderId); },
  };
}
