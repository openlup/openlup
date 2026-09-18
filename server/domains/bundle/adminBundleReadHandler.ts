import {
  allocateBundleTargetPrice,
  type BundleAllocationFailure,
} from "@openlup/core/pricing";

import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type {
  BundleHistoryRequest,
  BundlePricePreview,
  GetBundleRequest,
  ListBundlesRequest,
  PreviewBundlePriceRequest,
} from "../../../src/domains/bundle/adminBundleReadContracts.js";
import {
  bundleHistoryResponseSchema,
  getBundleResponseSchema,
  listBundlesResponseSchema,
  previewBundlePriceResponseSchema,
} from "../../../src/domains/bundle/adminBundleReadContracts.js";
import {
  bundleSpec,
  BUNDLE_READ_FLAG,
  type BundleQueryKey,
} from "../../../src/domains/bundle/bundleSpec.js";
import type { AgentDomainQuerySpec } from "../../../src/lib/agent-domain/domainSpec.js";
import { createAdminParameterizedReadHandler } from "../../_lib/admin-domain/handlers.js";
import type { AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";
import type {
  BundleAvailabilityRow,
  BundleAvailabilityService,
} from "./bundleAvailabilityService.js";
import { BundleRpcError } from "./adminBundleWritePort.js";
import type {
  BundleCatalogReadPort,
  BundleDetail,
  BundleHistoryResult,
  ListBundlesResult,
} from "./bundleCatalogReadPort.js";

/**
 * Bundle READ handlers — each is the generic kit factory
 * `createAdminParameterizedReadHandler` driven by one query of `bundleSpec`. The
 * factory owns the shared spine (GET-only, flag gate, admin authz, DB-derived
 * actor-kind gate, query parse, error map, response validation, success
 * envelope); this module only injects the read-port call and the response shape.
 * It mirrors `adminBundleHandler.ts`, and the catalog reference
 * (`server/domains/commerce/adminCatalogReadHandler.ts`) is the shape both follow.
 *
 * The price preview is the one read that computes: it runs the SAME pricing kernel
 * the write boundary refuses against (`allocateBundleTargetPrice`) over TODAY's
 * component prices, so an operator can see the money before committing to it. Its
 * three refusal codes are mapped onto the same envelope a refused write produces,
 * because they are the same three decisions.
 */

export { BUNDLE_READ_FLAG };

const BUNDLE_READ_DISABLED = "Bundle reads are disabled";
const BUNDLE_READ_INVALID = "Invalid bundle read request";
const BUNDLE_READ_FAILURE = "Bundle read failed";

export interface AdminBundleReadHandlerDeps {
  readPort: BundleCatalogReadPort;
  authorizeAdmin: AuthorizeAdmin;
  readsEnabled: boolean;
  /**
   * Derived stock for the detail response. OPTIONAL, and absence is reported as a null
   * `availability` rather than as an omitted field or a zero: a deployment with no stock rail has
   * not counted anything, and saying so is different from saying nothing can ship.
   */
  availabilityService?: BundleAvailabilityService;
}

function query<TReq>(key: BundleQueryKey): AgentDomainQuerySpec<TReq> {
  const spec = bundleSpec.queries?.[key];
  if (!spec) throw new Error(`bundleSpec.queries.${key} is not defined`);
  return spec as AgentDomainQuerySpec<TReq>;
}

function gate<TReq, TData>(
  deps: AdminBundleReadHandlerDeps,
  key: BundleQueryKey,
  load: (port: BundleCatalogReadPort, input: TReq) => Promise<TData>,
  toResponse: (data: TData) => Record<string, unknown>,
  responseSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  invalidResponseMessage: string,
) {
  return createAdminParameterizedReadHandler<TReq, TData>({
    query: query<TReq>(key),
    flagName: bundleSpec.readFlag,
    enabled: deps.readsEnabled,
    authorizeAdmin: deps.authorizeAdmin,
    load: (_actorId, input) => load(deps.readPort, input),
    toResponse,
    responseSchema,
    disabledMessage: BUNDLE_READ_DISABLED,
    invalidRequestMessage: BUNDLE_READ_INVALID,
    invalidResponseMessage,
    failureMessage: BUNDLE_READ_FAILURE,
  });
}

export function createAdminBundleListHandler(deps: AdminBundleReadHandlerDeps) {
  return gate<ListBundlesRequest, ListBundlesResult>(
    deps,
    "list",
    (port, input) => port.listBundles(input),
    (data) => ({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      bundles: data.bundles,
      total: data.total,
    }),
    listBundlesResponseSchema,
    "Invalid bundle list response",
  );
}

interface BundleDetailWithStock {
  bundle: BundleDetail;
  stock: BundleAvailabilityRow | null;
}

export function createAdminBundleGetHandler(deps: AdminBundleReadHandlerDeps) {
  return gate<GetBundleRequest, BundleDetailWithStock>(
    deps,
    "get",
    async (port, input) => {
      const bundle = await port.getBundle(input);
      // Absent is NOT an empty detail: the same P0002 the write boundary raises,
      // so a missing bundle answers 404 through one map rather than two.
      if (!bundle) throw new BundleRpcError("P0002", "bundle_not_found");
      return { bundle, stock: await describeStock(deps, bundle) };
    },
    ({ bundle, stock }) => ({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      bundle: toDetailView(bundle, stock),
    }),
    getBundleResponseSchema,
    "Invalid bundle detail response",
  );
}

/**
 * Fold stock into ONE bundle, through the same service the public feed uses.
 *
 * The service takes compositions and this is a detail, but the two carry the identical component
 * row type, so the adaptation is a rename rather than a translation — and routing this read through
 * the shared service is the point: `deriveBundleAvailability` stays the single place that folds
 * units into bundles, so an operator's detail page and a shopper's feed can never disagree about
 * the same bundle.
 *
 * A bundle whose status is not live is NOT skipped here. That is the whole gain over the feed: the
 * feed is live-only by construction, so a draft had no derived stock anywhere, and an operator
 * about to activate one could not see whether it would ship.
 */
async function describeStock(
  deps: AdminBundleReadHandlerDeps,
  bundle: BundleDetail,
): Promise<BundleAvailabilityRow | null> {
  if (!deps.availabilityService) return null;
  const [row] = await deps.availabilityService.describeCompositions([
    {
      code: bundle.code,
      title: bundle.title,
      fulfillmentMode: bundle.fulfillmentMode,
      // Stated from what the detail resolved. Neither reaches the stock question — the service
      // asks the availability port for units, never for money — but the shape is the contract and
      // inventing a currency here would be a lie in a field somebody may later read.
      currency: bundle.resolvedCurrency ?? "",
      targetPriceMinor: 0,
      mode: "any",
      components: bundle.components,
    },
  ]);
  return row ?? null;
}

export function createAdminBundleHistoryHandler(deps: AdminBundleReadHandlerDeps) {
  return gate<BundleHistoryRequest, BundleHistoryResult>(
    deps,
    "history",
    (port, input) => port.listBundleHistory(input),
    (data) => ({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      events: data.events,
      total: data.total,
    }),
    bundleHistoryResponseSchema,
    "Invalid bundle history response",
  );
}

export function createAdminBundlePreviewPriceHandler(deps: AdminBundleReadHandlerDeps) {
  return gate<PreviewBundlePriceRequest, BundlePricePreview>(
    deps,
    "previewPrice",
    async (port, input) => {
      const bundle = await port.getBundle({
        code: input.code,
        currency: input.currency,
        mode: input.mode,
      });
      if (!bundle) throw new BundleRpcError("P0002", "bundle_not_found");
      return previewBundlePrice(bundle, input);
    },
    (preview) => ({ contractVersion: COMMERCE_CONTRACT_VERSION, preview }),
    previewBundlePriceResponseSchema,
    "Invalid bundle price preview response",
  );
}

/** The detail the transport carries: the port's internal variant id stays server-side. */
function toDetailView(bundle: BundleDetail, stock: BundleAvailabilityRow | null): Record<string, unknown> {
  const { components, resolvedPriceListId: _priceListId, ...rest } = bundle;
  return {
    ...rest,
    components: components.map(({ variantId: _variantId, ...component }) => component),
    availability: stock
      ? {
          sellableNow: stock.availability.sellableNow,
          status: stock.availability.status,
          reasonCode: stock.availability.reasonCode,
          limitingSku: stock.availability.limitingSku,
          components: stock.components.map((component) => ({
            sku: component.sku,
            quantity: component.quantity,
            isAddon: component.isAddon,
            sellableNow: component.sellableNow,
          })),
        }
      : null,
  };
}

/**
 * Run the pricing kernel over the bundle's live component prices.
 *
 * Every refusal is stated as the same rule violation a write would produce, so an
 * operator previewing a price and an operator setting it are told the same thing:
 * no priced list (P0002), an unpriced component or an empty set (P0001), and the
 * kernel's own three failure codes (P0001).
 */
function previewBundlePrice(
  bundle: BundleDetail,
  input: PreviewBundlePriceRequest,
): BundlePricePreview {
  if (!bundle.resolvedPriceListId || !bundle.resolvedCurrency) {
    throw new BundleRpcError("P0002", "no_active_price_list");
  }
  const counted = bundle.components;
  if (counted.length === 0) throw new BundleRpcError("P0001", "min_components");
  const unpriced = counted.filter((component) => component.referenceUnitPriceMinor === null);
  if (unpriced.length > 0) {
    throw new BundleRpcError("P0001", `component_unpriced:${unpriced[0].sku}`);
  }

  const activePrice = bundle.prices.find(
    (price) => price.active && (!input.mode || price.mode === input.mode),
  );
  const targetPriceMinor = input.targetPriceMinor ?? activePrice?.targetPriceMinor;
  if (targetPriceMinor === undefined) throw new BundleRpcError("P0002", "no_active_target_price");

  const allocation = allocateBundleTargetPrice({
    components: counted.map((component) => ({
      sku: component.sku,
      quantity: component.quantity,
      unitPriceMinor: component.referenceUnitPriceMinor as number,
    })),
    targetPriceMinor,
  });
  // The narrowing is written out rather than relied upon: the Node tsconfig runs
  // without strictNullChecks, where a discriminated union does not narrow on `ok`.
  if (!allocation.ok) throw new BundleRpcError("P0001", (allocation as BundleAllocationFailure).code);

  return {
    bundleCode: bundle.code,
    priceListId: bundle.resolvedPriceListId,
    mode: input.mode ?? activePrice?.mode ?? "any",
    currency: bundle.resolvedCurrency,
    referenceTotalMinor: allocation.referenceTotalMinor,
    targetPriceMinor: allocation.targetPriceMinor,
    discountTotalMinor: allocation.discountTotalMinor,
    discountBps: allocation.discountBps,
    floorApplied: allocation.floorApplied,
    componentTargets: allocation.components,
    allocatedLines: allocation.lines,
  };
}
