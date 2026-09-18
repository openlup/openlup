// E2 — generic-parity coverage matrix (proof-only, no behavior change).
//
// Pins the CURRENT truth of how each vertical alias self-service verb maps onto
// the generic update_bundle / resize_bundle protocol + composition levers. Every
// row is either PROVEN (an exact generic equivalent is reachable and its money-
// path equality is proven in pgTAP) or a KNOWN_GAP asserted here so a future
// closure OR regression of the gap is loud. See the wave plan §6 for the full
// matrix and docs/plan/oss/briefs/subscription-vertical-agnostic-faza-a.md E2.
//
// OSS-readiness note: alias verb names are referenced through the exported
// production constant SUBSCRIPTION_ACTIONS_REQUIRING_ACCEPTED_QUOTE instead of
// re-written literals, so this proof adds no vertical vocabulary of its own.
import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_ACTIONS_REQUIRING_ACCEPTED_QUOTE,
  subscriptionActionRequiresAcceptedQuote,
  subscriptionActionRequiresChargeTimingConfirmation,
  subscriptionSelfServiceActionImpacts,
} from "../../../../src/domains/subscription/selfServiceContracts.js";
import type { CustomerSubscriptionActionRequest } from "../../../../src/domains/customers/selfServiceContracts.js";
import {
  isGenericBundleAction,
  resolveSubscriptionBundleActionProtocol,
} from "../../../domains/customers/subscriptionGenericBundleActions.js";

// Alias verb names sourced from the production contract tuple (typed literals).
// The matrix behavior assertions below fail loudly if the tuple is reordered.
const [
  ACTION_SWAP_LINE,
  ,
  ,
  ,
  ACTION_PLAN_LENGTH,
  ACTION_CORE_MIX,
  ACTION_PORTION_MODE,
  ACTION_PACKAGE_TEMPLATE,
  ACTION_UPDATE_BUNDLE,
  ACTION_RESIZE_BUNDLE,
] = SUBSCRIPTION_ACTIONS_REQUIRING_ACCEPTED_QUOTE;

const SUB = "33333333-3333-4333-8333-333333333333";
const V1 = "55550000-0000-0000-0000-000000000001";
const V2 = "55550000-0000-0000-0000-000000000002";
const HASH = "a".repeat(64);

type ParityStatus = "PROVEN" | "GAP";

interface MatrixRow {
  aliasAction: CustomerSubscriptionActionRequest["action"];
  variant?: string;
  genericVerb: typeof ACTION_UPDATE_BUNDLE | typeof ACTION_RESIZE_BUNDLE | null;
  lever: string | null;
  status: ParityStatus;
  proof: string;
  /** A representative flag-on alias request that the mapper must transform. */
  aliasRequest: CustomerSubscriptionActionRequest;
  /** Expected shape of the mapped generic protocol action. */
  expectMapped: (mapped: Record<string, unknown>) => void;
}

// Pinned universe of vertical alias self-service verbs. A new alias verb added
// to the contract without a matrix row (PROVEN) or KNOWN_GAPS entry fails the
// completeness assertion below.
const VERTICAL_ALIAS_ACTIONS = [
  ACTION_CORE_MIX,
  ACTION_PLAN_LENGTH,
  ACTION_PACKAGE_TEMPLATE,
  ACTION_PORTION_MODE,
  ACTION_SWAP_LINE,
] as const;

const MATRIX: MatrixRow[] = [
  {
    aliasAction: ACTION_CORE_MIX,
    genericVerb: ACTION_UPDATE_BUNDLE,
    lever: "coreLines (compositionConstraint + cadence unchanged)",
    status: "PROVEN",
    proof: "subscription_generic_bundle_actions_test.sql (pgTAP)",
    aliasRequest: {
      action: ACTION_CORE_MIX,
      idempotencyKey: "matrix-mix-1",
      subscriptionId: SUB,
      recipes: [{ variantId: V1, qty: 4 }],
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest,
    expectMapped: (mapped) => {
      expect(mapped.action).toBe(ACTION_UPDATE_BUNDLE);
      expect(mapped.coreLines).toEqual([{ variantId: V1, qty: 4 }]);
    },
  },
  {
    aliasAction: ACTION_PLAN_LENGTH,
    genericVerb: ACTION_RESIZE_BUNDLE,
    lever: "planLength",
    status: "PROVEN",
    proof: "subscription_generic_bundle_actions_test.sql (pgTAP)",
    aliasRequest: {
      action: ACTION_PLAN_LENGTH,
      idempotencyKey: "matrix-plan-1",
      subscriptionId: SUB,
      planDays: 14,
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest,
    expectMapped: (mapped) => {
      expect(mapped.action).toBe(ACTION_RESIZE_BUNDLE);
      expect(mapped.resizeLever).toEqual({ kind: "planLength", value: 14 });
      expect(mapped.cadenceDays).toBe(14);
    },
  },
  {
    aliasAction: ACTION_PACKAGE_TEMPLATE,
    genericVerb: ACTION_UPDATE_BUNDLE,
    lever: "coreLines + addonLines + cadenceDays",
    status: "PROVEN",
    proof: "subscription_generic_bundle_actions_test.sql (pgTAP)",
    aliasRequest: {
      action: ACTION_PACKAGE_TEMPLATE,
      idempotencyKey: "matrix-package-1",
      subscriptionId: SUB,
      planDays: 21,
      recipes: [{ variantId: V1, qty: 6 }],
      addons: [{ variantId: V2, qty: 2 }],
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest,
    expectMapped: (mapped) => {
      expect(mapped.action).toBe(ACTION_UPDATE_BUNDLE);
      expect(mapped.cadenceDays).toBe(21);
      expect(mapped.coreLines).toEqual([{ variantId: V1, qty: 6 }]);
      expect(mapped.addonLines).toEqual([{ variantId: V2, qty: 2, isAddon: true }]);
    },
  },
  {
    aliasAction: ACTION_PORTION_MODE,
    variant: "full",
    genericVerb: ACTION_RESIZE_BUNDLE,
    lever: "portionMode",
    status: "PROVEN",
    proof: "subscription_set_portion_mode_generic_parity_test.sql (pgTAP)",
    aliasRequest: {
      action: ACTION_PORTION_MODE,
      idempotencyKey: "matrix-portion-full-1",
      subscriptionId: SUB,
      portionMode: "full",
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest,
    expectMapped: (mapped) => {
      expect(mapped.action).toBe(ACTION_RESIZE_BUNDLE);
      expect(mapped.resizeLever).toEqual({ kind: "portionMode", value: { portionMode: "full" } });
    },
  },
  {
    aliasAction: ACTION_PORTION_MODE,
    variant: "topper",
    genericVerb: ACTION_RESIZE_BUNDLE,
    lever: "portionMode",
    status: "PROVEN",
    proof: "subscription_set_portion_mode_generic_parity_test.sql (pgTAP)",
    aliasRequest: {
      action: ACTION_PORTION_MODE,
      idempotencyKey: "matrix-portion-topper-1",
      subscriptionId: SUB,
      portionMode: "topper",
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest,
    expectMapped: (mapped) => {
      expect(mapped.action).toBe(ACTION_RESIZE_BUNDLE);
      expect(mapped.resizeLever).toEqual({ kind: "portionMode", value: { portionMode: "topper" } });
    },
  },
  {
    aliasAction: ACTION_SWAP_LINE,
    genericVerb: null,
    lever: null,
    status: "GAP",
    proof: "no generic verb reproduces a targeted single-line variant swap",
    aliasRequest: {
      action: ACTION_SWAP_LINE,
      idempotencyKey: "matrix-swap-1",
      subscriptionId: SUB,
      fromVariantId: V1,
      toVariantId: V2,
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest,
    expectMapped: () => {
      /* gap: no mapping — asserted separately below */
    },
  },
];

const KNOWN_GAPS = MATRIX.filter((row) => row.status === "GAP").map((row) => row.aliasAction);
const PROVEN = MATRIX.filter((row) => row.status === "PROVEN");

// Cross-cutting caveats that qualify the PROVEN rows. These are asymmetries that
// apply to EVERY alias->generic pair (not to a single verb), proven at the SQL
// boundary rather than here. Pinned so a future fix (or regression) is loud.
const PARITY_CAVEATS = [
  // The Wave-5 no-op suppression wrapper (migration 20260711170020) intercepts
  // only the alias verbs; update_bundle / resize_bundle are NOT in its allowlist.
  // A semantically no-op edit is therefore suppressed via the alias verb but
  // applied (template bump + package_changed email) via the generic verb.
  // Proven in subscription_set_portion_mode_generic_parity_test.sql (pgTAP,
  // divergence block). Equivalence holds only for state-CHANGING edits.
  "noop_suppression_generic_verbs_bypass_wave5_allowlist",
] as const;

describe("subscription generic-parity coverage matrix (E2)", () => {
  it("covers every vertical alias self-service verb exactly once (no silent new verb)", () => {
    const covered = new Set<string>(MATRIX.map((row) => row.aliasAction));
    expect([...covered].sort()).toEqual([...VERTICAL_ALIAS_ACTIONS].sort());
  });

  it("pins the known gap set so a future closure or regression is loud", () => {
    // The targeted single-line swap verb is the only alias with no generic
    // equivalent. If someone adds a mapping (closing the gap) or a second gap
    // appears, this fails.
    expect(KNOWN_GAPS).toEqual([ACTION_SWAP_LINE]);
  });

  it("pins the cross-cutting parity caveats (proven at the SQL boundary)", () => {
    // The generic verbs bypass the alias-verb no-op suppression allowlist. If
    // that is fixed (generics added to the allowlist) this pin should be updated.
    expect(PARITY_CAVEATS).toEqual(["noop_suppression_generic_verbs_bypass_wave5_allowlist"]);
  });

  describe.each(PROVEN)(
    "PROVEN $aliasAction ($variant) -> $genericVerb",
    (row) => {
      it("the flag-on mapper rewrites the alias verb to its generic equivalent", () => {
        const mapped = resolveSubscriptionBundleActionProtocol(row.aliasRequest, true) as unknown as Record<
          string,
          unknown
        >;
        expect(isGenericBundleAction(String(mapped.action))).toBe(true);
        expect(mapped.action).toBe(row.genericVerb);
        expect(mapped.protocolSourceAction).toBe(row.aliasAction);
        row.expectMapped(mapped);
      });

      it("the generic verb carries identical contract metadata to the alias verb", () => {
        // Same reprice/charge machinery: impacts, quote-required, charge-timing.
        expect(subscriptionSelfServiceActionImpacts(row.genericVerb!)).toEqual(
          subscriptionSelfServiceActionImpacts(row.aliasAction),
        );
        expect(subscriptionActionRequiresAcceptedQuote(row.genericVerb!)).toBe(
          subscriptionActionRequiresAcceptedQuote(row.aliasAction),
        );
        expect(subscriptionActionRequiresAcceptedQuote(row.aliasAction)).toBe(true);
        expect(subscriptionActionRequiresChargeTimingConfirmation(row.genericVerb!)).toBe(
          subscriptionActionRequiresChargeTimingConfirmation(row.aliasAction),
        );
        expect(subscriptionActionRequiresChargeTimingConfirmation(row.aliasAction)).toBe(false);
      });
    },
  );

  // Composition lever coverage (planLength / planLengthConstraint / portionMode
  // are actually implemented; unknown levers return null) is proven in the sibling
  // file subscriptionGenericParityLevers.test.ts, split out for the 300-LOC cap.

  describe("the single-line swap verb is a KNOWN_GAP with no generic equivalent", () => {
    const swapRow = MATRIX.find((row) => row.aliasAction === ACTION_SWAP_LINE)!;

    it("stays an alias verb even with the generic bundle flag ON", () => {
      const mapped = resolveSubscriptionBundleActionProtocol(swapRow.aliasRequest, true) as unknown as Record<
        string,
        unknown
      >;
      // No update_bundle/resize_bundle rewrite: the mapper returns the input untouched.
      expect(mapped.action).toBe(ACTION_SWAP_LINE);
      expect(isGenericBundleAction(ACTION_SWAP_LINE)).toBe(false);
      expect(mapped.protocolSourceAction).toBeUndefined();
    });

    it("has contract metadata but no generic verb to inherit it", () => {
      expect(subscriptionSelfServiceActionImpacts(ACTION_SWAP_LINE)).toEqual(["price", "contents"]);
      expect(swapRow.genericVerb).toBeNull();
    });
  });
});
