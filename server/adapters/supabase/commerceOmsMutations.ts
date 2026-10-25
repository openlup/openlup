import * as managed from "@openlup/platform/commerce/server";
import { omsManagedStore,type CommerceOmsClient } from "./commerce/oms/types.js";
export { callOmsRpc, mapRpcError } from "@openlup/platform/commerce/server";
export function addCommerceOmsNote(client: CommerceOmsClient, request: Parameters<typeof managed.addCommerceOmsNote>[1]) { return managed.addCommerceOmsNote(omsManagedStore(client), request); }
export function updateCommerceOmsShippingAddress(client: CommerceOmsClient, request: Parameters<typeof managed.updateCommerceOmsShippingAddress>[1]) { return managed.updateCommerceOmsShippingAddress(client, request); }
