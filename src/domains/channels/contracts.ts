import { z } from "../../lib/validation/zod.js";

// Shared vocabulary for the sales-channel domain: external marketplaces,
// aggregators, and any future sales source (storefront, mobile app, POS).
//
// Identity spaces (channel slugs, connector kinds, sales-channel kinds,
// sellable kinds) are OPEN validated strings — never z.enum — so adopters and
// later connectors extend them without a contract change
// (noEnumOverOpenValueSpace). Lifecycle/policy vocabularies (statuses,
// buyer-comms owner, invoice policy) are closed by design: they are state
// machines this domain owns, not brand or provider unions.

export const CHANNELS_CONTRACT_VERSION = "channels.v1";

/** Operator-facing stable identity of a sales channel, e.g. "marketplace-eu". */
export const channelSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    "channel slug must be lowercase kebab-case, max 64 chars",
  );

/**
 * Connector implementation identity (open string, e.g. "noop_channel";
 * later real kinds are added by their own adapter waves, never enumerated
 * here — a closed union of connector brands is forbidden in wire contracts).
 */
export const connectorProviderKindSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    "connector provider kind must be lowercase snake_case, max 64 chars",
  );

/**
 * Structural shape of a connector, NOT a brand union: a `direct` connector's
 * connection addresses exactly one sales surface; an `aggregator` connection
 * fans out to N surfaces (each addressed via `channelExternalRef`).
 */
export const connectorShapeSchema = z.enum(["direct", "aggregator"]);
export type ConnectorShape = z.infer<typeof connectorShapeSchema>;

/**
 * What kind of sales surface a channel is. Open value space; known values
 * today: "marketplace", "storefront", "app".
 */
export const salesChannelKindSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,31}$/,
    "sales channel kind must be lowercase, max 32 chars",
  );

export const SALES_CHANNEL_STATUSES = [
  "disabled",
  "testing",
  "active",
  "sunset",
] as const;
export const salesChannelStatusSchema = z.enum(SALES_CHANNEL_STATUSES);
export type SalesChannelStatus = z.infer<typeof salesChannelStatusSchema>;

/** Who talks to the buyer for orders from this channel. */
export const buyerCommsOwnerSchema = z.enum(["platform", "channel"]);
export type BuyerCommsOwner = z.infer<typeof buyerCommsOwnerSchema>;

/** Who issues the sales invoice for orders from this channel. */
export const invoicePolicySchema = z.enum(["issue", "suppress", "channel_issues"]);
export type InvoicePolicy = z.infer<typeof invoicePolicySchema>;

/**
 * Sellable kinds a listing or an order line can reference. Open value space
 * in storage; the `channel.order.v1` line union handles exactly the known
 * kinds, and a new kind arrives with a contract version bump.
 */
export const SELLABLE_KIND_SKU = "sku";
export const SELLABLE_KIND_BUNDLE = "bundle";
export const sellableKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "sellable kind must be lowercase, max 32 chars");

/** Open ISO-4217 currency code — deliberately not pinned to any one currency. */
export const channelCurrencySchema = z.string().regex(/^[A-Z]{3}$/);

/** Open ISO-3166-1 alpha-2 country code. */
export const channelCountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

/** External identifiers minted by a marketplace/aggregator, stored verbatim. */
export const externalRefSchema = z.string().trim().min(1).max(128);
