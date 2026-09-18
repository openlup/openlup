// Public cross-domain port surface of the channels domain. Cross-domain
// imports are limited to a domain's contracts/ports/types files, so every
// connector-port type is re-exported here; `connectorPort.ts` stays the
// single definition site.

export type {
  ChannelBinding,
  ChannelConnectorCapabilities,
  ChannelConnectorCorrelationContract,
  ChannelConnectorPort,
  ChannelListingSyncPort,
  ChannelOrderSourcePort,
  ChannelShipmentSyncPort,
  ChannelStockPricePushPort,
  NormalizedWebhookResult,
  SellableRef,
} from "./connectorPort.js";

// Outbound-effect policy (wave B6). Commerce and accounting decide what to send
// and what to issue for a channel order, so the two pure resolvers and their
// input shapes are part of this domain's public seam. `orderCommsPolicy.ts` and
// `orderInvoicePolicy.ts` stay the single definition sites.
export type { OrderBuyerCommsPolicy } from "./orderCommsPolicy.js";
export { platformOwnsBuyerEmail } from "./orderCommsPolicy.js";
export type { ChannelInvoiceAction, OrderInvoicePolicy } from "./orderInvoicePolicy.js";
export { platformIssuesInvoice, resolveOrderInvoiceAction } from "./orderInvoicePolicy.js";
