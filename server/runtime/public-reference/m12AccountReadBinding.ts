import { createAccountReadFacade } from "@openlup/platform/account-support";
import type { CustomerAccountPort, CustomerOrdersPort } from "../../domains/customers/ports.js";

/** Explicit reference binding; injects existing owners without selecting a graph,
 * constructing providers or supplying application profile/market defaults.
 */
export function createM12AccountReadBinding(ports: {
  account: CustomerAccountPort;
  orders: CustomerOrdersPort;
}) {
  return createAccountReadFacade(ports);
}
