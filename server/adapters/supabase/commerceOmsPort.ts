import { createManagedCommerceOmsPort, mapReplacementRefusal } from "@openlup/platform/commerce/server";
import type { CommerceOmsHoldPort,CommerceOmsReadPort } from "../../../src/domains/commerce/omsPorts.js";
import type { OmsActionAvailabilityFlags } from "../../../src/domains/commerce/omsReadModelHelpers.js";
import { referenceOmsManagedProjections } from "./commerce/oms/referenceProjections.js";
import type { CommerceOmsSupabaseClient } from "./commerce/oms/types.js";
export type { CommerceOmsSupabaseClient } from "./commerce/oms/types.js";
export { mapReplacementRefusal };
export function createSupabaseCommerceOmsPort(client: CommerceOmsSupabaseClient, options: { actionFlags?: OmsActionAvailabilityFlags } = {}): CommerceOmsReadPort & CommerceOmsHoldPort {
 return createManagedCommerceOmsPort(client, { ...options, queries: { query: table => client.from(table) }, projections: referenceOmsManagedProjections }) as CommerceOmsReadPort & CommerceOmsHoldPort;
}
