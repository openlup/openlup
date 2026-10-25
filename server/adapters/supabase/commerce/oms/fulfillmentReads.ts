import * as managed from "@openlup/platform/commerce/server";
import { omsManagedStore,type CommerceOmsClient } from "./types.js";
export function readShipmentRefsByOrderIds(client: CommerceOmsClient, ...args: Parameters<typeof managed.readShipmentRefsByOrderIds> extends [unknown, ...infer Rest] ? Rest : never) { return managed.readShipmentRefsByOrderIds(omsManagedStore(client), ...args); }
export function readShipmentRefsByOrderId(client: CommerceOmsClient, ...args: Parameters<typeof managed.readShipmentRefsByOrderId> extends [unknown, ...infer Rest] ? Rest : never) { return managed.readShipmentRefsByOrderId(omsManagedStore(client), ...args); }
export { isOptionalProviderEvidenceColumnError } from "@openlup/platform/commerce/server";
export function readFulfillmentParcelsByOrderId(client: CommerceOmsClient, ...args: Parameters<typeof managed.readFulfillmentParcelsByOrderId> extends [unknown, ...infer Rest] ? Rest : never) { return managed.readFulfillmentParcelsByOrderId(omsManagedStore(client), ...args); }
export function readFulfillmentOrdersByOrderIds(client: CommerceOmsClient, ...args: Parameters<typeof managed.readFulfillmentOrdersByOrderIds> extends [unknown, ...infer Rest] ? Rest : never) { return managed.readFulfillmentOrdersByOrderIds(omsManagedStore(client), ...args); }
