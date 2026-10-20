/**
 * The semantic READ port for bundles.
 *
 * This file names the CAPABILITY, never the storage: no table, no routine, no
 * data-client type and no vendor appears here, and the domain layer opens no
 * database handle of its own. Both shipped adapters — the two
 * `bundleCatalogStore.ts` modules under `server/adapters/` — implement exactly this
 * interface and are proved against ONE shared scenario table, so a caller cannot
 * tell them apart. It is the same shape the write port
 * (`adminBundleWritePort.ts`) established in the previous wave.
 *
 * Reads are plain SELECTs rather than security-definer routines: the write
 * boundary is where authority lives, and a read that re-implemented it would be a
 * second place for the same rules to be written down. The admin surface reads the
 * whole lifecycle (draft, active, archived); the sellable feed asks a separate
 * question and gets only what is live.
 *
 * COMPONENT PRICES ARE RESOLVED, NOT STORED. A bundle stores one target price for
 * the whole set; a component's REFERENCE unit price is whatever the selected
 * price list says today. The adapters therefore join the catalogue and the price
 * list themselves, and hand back a resolved figure (or `null` when the list
 * prices nothing for that unit) so the allocator upstream never re-reads storage.
 */

/**
 * A read that FAILED, as opposed to a read that found nothing.
 *
 * Both adapters raise this rather than returning an empty page, because the two
 * outcomes are opposite: an empty catalogue is a fact a storefront may cache and
 * show, and a failed query is not. The class lives on the port so neither chain
 * owns the distinction — and so this file carries the executable line the changed-
 * runtime coverage lane requires of every `server/**` module.
 */
export class BundleCatalogReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleCatalogReadError";
  }
}

/** Which lifecycle rows an admin list asks for. `all` is the admin default. */
export type BundleListStatusFilter = "draft" | "active" | "archived" | "all";

export interface ListBundlesInput {
  status: BundleListStatusFilter;
  /** Free-text match over code and title; absent means no narrowing. */
  query?: string;
  limit: number;
  offset: number;
}

export interface BundleSummary {
  code: string;
  title: string;
  status: string;
  fulfillmentMode: string;
  componentCount: number;
  hasActiveTargetPrice: boolean;
  updatedAt: string;
}

export interface ListBundlesResult {
  bundles: BundleSummary[];
  total: number;
}

/**
 * One line of the bill of materials, already joined to the catalogue.
 *
 * `productSlug` and `variantId` are carried because the availability port
 * addresses stock by all three coordinates; a caller that had only the sku would
 * have to re-open the catalogue to ask about stock, which is exactly the
 * round-trip this DTO exists to remove.
 */
export interface BundleComponentRow {
  sku: string;
  title: string | null;
  productSlug: string;
  variantId: string;
  quantity: number;
  isAddon: boolean;
  sortOrder: number;
  /** Resolved from the selected price list; `null` when it prices no such unit. */
  referenceUnitPriceMinor: number | null;
}

export interface BundleTargetPriceRow {
  mode: string;
  targetPriceMinor: number;
  currency: string;
  amountKind: string;
  active: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface BundleDetail extends BundleSummary {
  /** The opaque `{kind, version, data}` envelope; `null` for an unconstrained bundle. */
  compositionConstraint: { kind: string; version: number; data: Record<string, unknown> } | null;
  metadata: Record<string, unknown>;
  components: BundleComponentRow[];
  prices: BundleTargetPriceRow[];
  /** The currency whose list resolved `referenceUnitPriceMinor`; `null` if none did. */
  resolvedCurrency: string | null;
  /**
   * The price list those reference figures came from. Carried because a price
   * preview has to name the list it priced against — an amount without the list
   * that gave it meaning is not reproducible.
   */
  resolvedPriceListId: string | null;
}

export interface GetBundleInput {
  code: string;
  /**
   * Price the components against THIS currency's active list. Omitted means "the
   * list this bundle's own active target price is written into", which is the
   * only currency an operator has actually chosen for it.
   */
  currency?: string;
  /** Narrow the target price whose list is selected; omitted means any mode. */
  mode?: string;
}

/**
 * One live, sellable bundle: active status, an active target price, and its
 * components priced in that price's own currency. This is the feed's row, and it
 * is deliberately a different question from `getBundle` — the storefront must
 * never be able to see a draft by asking the read port nicely.
 */
export interface ActiveBundleComposition {
  code: string;
  title: string;
  fulfillmentMode: string;
  currency: string;
  targetPriceMinor: number;
  mode: string;
  components: BundleComponentRow[];
}

export interface BundleHistoryEvent {
  id: string;
  action: string;
  actorKind: string | null;
  actorEmail: string | null;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  occurredAt: string;
}

export interface BundleHistoryInput {
  code: string;
  limit: number;
  offset: number;
}

export interface BundleHistoryResult {
  events: BundleHistoryEvent[];
  total: number;
}

export interface BundleCatalogReadPort {
  /** Admin list across the whole lifecycle, newest-agnostic and code-ordered. */
  listBundles(input: ListBundlesInput): Promise<ListBundlesResult>;
  /** Full admin detail, or `null` when no bundle carries that code. */
  getBundle(input: GetBundleInput): Promise<BundleDetail | null>;
  /**
   * Every bundle a storefront may sell right now. Never returns a draft or an
   * archived bundle, and never a bundle without an active target price.
   */
  listActiveBundleCompositions(input?: { currency?: string }): Promise<ActiveBundleComposition[]>;
  /**
   * The operator trail for one bundle. The two chains answer from different
   * ledgers — a managed audit table and the platform's neutral write-event
   * relation — which is why this is a port method rather than a shared query.
   */
  listBundleHistory(input: BundleHistoryInput): Promise<BundleHistoryResult>;
}
