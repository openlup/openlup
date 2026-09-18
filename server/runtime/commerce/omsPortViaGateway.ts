// Gateway-backed Commerce OMS read/hold port builder (Platform Portability, W6).
//
// The Commerce OMS read path already has a clean PORT boundary
// (`createSupabaseCommerceOmsPort` returns `CommerceOmsReadPort & CommerceOmsHoldPort`, fed a narrow
// structural `CommerceOmsSupabaseClient`). The ~40 inline `.from(...)` reads in
// The managed query implementation now lives in its named Supabase adapter. What was missing in W6
// was a way for the DataGatewayPort to SUPPLY the client, so OMS routes can
// stop building a service-role client inline (6 routes via createServiceRoleClient).
//
// This builder bridges the two: it runs `gateway.asService(...)` and constructs the existing OMS port
// over the gateway-supplied (elevated) client. Query behavior is UNCHANGED — same factory, same read
// queries — so the commerce-OMS tests + golden-master stay byte-identical. Migrating the 6 OMS routes
// to this helper is a conservative follow-up (W6b); this wave lands the seam + its test as the proof
// of the boundary without a 6-route rewrite.

import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";
import type {
  CommerceOmsHoldPort,
  CommerceOmsReadPort,
} from "../../../src/domains/commerce/omsPorts.js";
import type { OmsActionAvailabilityFlags } from "../../../src/domains/commerce/omsReadModelHelpers.js";
import { createSupabaseCommerceOmsPort } from "../../adapters/supabase/commerceOmsPort.js";
import type { CommerceOmsSupabaseClient } from "../../adapters/supabase/commerce/oms/types.js";

export interface CommerceOmsPortViaGatewayOptions {
  actionFlags?: OmsActionAvailabilityFlags;
}

/**
 * Build the Commerce OMS read+hold port over a DataGateway-supplied elevated client.
 * The OMS port methods themselves capture the client, so each public method is wrapped to run inside
 * `gateway.asService(...)` — meaning a fresh elevated client is acquired per call, matching the
 * per-request service-client creation the inline routes do today (and pooling-correct on serverless).
 */
export function createCommerceOmsPortViaGateway(
  gateway: DataGatewayPort,
  options: CommerceOmsPortViaGatewayOptions = {},
): CommerceOmsReadPort & CommerceOmsHoldPort {
  const build = (client: unknown): CommerceOmsReadPort & CommerceOmsHoldPort =>
    createSupabaseCommerceOmsPort(client as CommerceOmsSupabaseClient, options);

  return {
    listOrders: (request) => gateway.asService((client) => build(client).listOrders(request)),
    getOrderDetail: (request) => gateway.asService((client) => build(client).getOrderDetail(request)),
    createHold: (request) => gateway.asService((client) => build(client).createHold(request)),
    releaseHold: (request) => gateway.asService((client) => build(client).releaseHold(request)),
    addNote: (request) => gateway.asService((client) => build(client).addNote(request)),
    updateShippingAddress: (request) =>
      gateway.asService((client) => build(client).updateShippingAddress(request)),
    markRefunded: (request) => gateway.asService((client) => build(client).markRefunded(request)),
    cancelOrder: (request) => gateway.asService((client) => build(client).cancelOrder(request)),
    requestReplacementShipment: (request) =>
      gateway.asService((client) => build(client).requestReplacementShipment(request)),
  };
}
