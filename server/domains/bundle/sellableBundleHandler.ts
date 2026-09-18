import { allocateBundleTargetPrice } from "@openlup/core/pricing";

import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  SELLABLE_BUNDLE_CONTRACT_VERSION,
  sellableBundleListResponseSchema,
  type SellableBundle,
} from "../../../src/domains/bundle/sellableBundleContracts.js";
import type { BundleAvailability } from "../../../src/domains/bundle/availability.js";
import type { ActiveBundleComposition } from "./bundleCatalogReadPort.js";
import type { BundleAvailabilityService } from "./bundleAvailabilityService.js";

/**
 * The public sellable-bundle feed handler, shaped after the reference catalog
 * handler (`server/domains/catalog/referenceCatalogHandler.ts`): GET-only, one
 * port call, validate the body before sending, and never serve an unvalidated
 * shape.
 *
 * It composes rather than computes twice: the availability service already folds
 * one batched stock answer into the live compositions, and the pricing kernel
 * turns the stored target price into per-component money. This module only decides
 * what a storefront is allowed to see.
 *
 * A bundle whose money cannot be derived is DROPPED from the feed, not published
 * with a guessed figure. Three cases reach that door — an unpriced component, an
 * empty composition, and a target price the kernel refuses — and all three mean
 * the same thing to a storefront: this is not sellable today. Publishing it with a
 * partial price would put a number on a shelf that no order line could reproduce.
 */

export interface SellableBundleHandlerDeps {
  availabilityService: BundleAvailabilityService;
  /** Narrow the feed to one currency; omitted means every currency an operator priced. */
  currency?: string;
  enabled: boolean;
}

export function createSellableBundleHandler(deps: SellableBundleHandlerDeps) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    if (!deps.enabled) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Bundle reads are disabled", {
        details: { reason: "feature_flag_disabled", featureFlag: "COMMERCE_BUNDLE_READ_ENABLED" },
      });
      return;
    }

    try {
      const rows = await deps.availabilityService.describeActiveBundles(
        deps.currency ? { currency: deps.currency } : {},
      );
      const response = sellableBundleListResponseSchema.safeParse({
        contractVersion: SELLABLE_BUNDLE_CONTRACT_VERSION,
        bundles: rows
          .map((row) => toSellableBundle(row.composition, row.availability))
          .filter((bundle): bundle is SellableBundle => bundle !== null),
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Sellable bundle feed returned an invalid shape");
        return;
      }
      sendBffSuccess(
        res,
        response.data,
        { contractVersion: SELLABLE_BUNDLE_CONTRACT_VERSION },
        { cacheControl: "no-store" },
      );
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Sellable bundles are unavailable");
    }
  };
}

/**
 * Derive the row a storefront sees, or `null` when the money cannot be stated.
 *
 * The allocator emits TWO lines for a quantity whose subtotal does not divide
 * evenly, which is exactly why the feed carries lines rather than a unit price per
 * component: `unitPrice x quantity === lineSubtotal` holds on every line, and the
 * lines sum to the bundle's price with no remainder.
 */
export function toSellableBundle(
  composition: ActiveBundleComposition,
  availability: BundleAvailability,
): SellableBundle | null {
  if (composition.components.length === 0) return null;
  if (composition.components.some((component) => component.referenceUnitPriceMinor === null)) {
    return null;
  }

  const allocation = allocateBundleTargetPrice({
    components: composition.components.map((component) => ({
      sku: component.sku,
      quantity: component.quantity,
      unitPriceMinor: component.referenceUnitPriceMinor as number,
    })),
    targetPriceMinor: composition.targetPriceMinor,
  });
  if (!allocation.ok) return null;

  // Basis points come from the per-component allocation, so a component split
  // across two lines reports the same discount on both halves rather than two
  // rounded figures that disagree.
  const discountBpsBySku = new Map(
    allocation.components.map((component) => [component.sku, component.discountBps]),
  );

  return {
    code: composition.code,
    title: composition.title,
    fulfillmentMode: composition.fulfillmentMode,
    price: { amountMinor: composition.targetPriceMinor, currency: composition.currency },
    components: allocation.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      effectiveUnitPriceMinor: line.effectiveUnitPriceMinor,
      lineSubtotalMinor: line.lineSubtotalMinor,
      discountBps: discountBpsBySku.get(line.sku) ?? 0,
    })),
    availability: {
      status: availability.status,
      sellableNow: availability.sellableNow,
      limitingSku: availability.limitingSku,
      reasonCode: availability.reasonCode,
    },
  };
}
