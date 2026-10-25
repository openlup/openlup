/** Host-verified selection; never an authorization claim from a request body. */
export interface CustomerContext { principalId: string; clientId: string; graph: "managed" | "native" }
export type AccountReadRefusal = "FORBIDDEN" | "NOT_FOUND" | "UPSTREAM_UNAVAILABLE" | "INVALID_RESPONSE";
/** Owner DTOs stay host supplied, including private profile and market fields.
 * Null and thrown failures retain their existing host mappings. No cursor is promised.
 */
export interface AccountReadPort<Account, OrderList, OrderDetail> {
  getAccount(userId: string): Promise<Account | null>;
  listOrders(userId: string, input: { limit: number }): Promise<OrderList | null>;
  getOrderDetail(userId: string, orderId: string): Promise<OrderDetail | null>;
}
