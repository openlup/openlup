import { describe, expect, it } from "vitest";
import type { OmsFulfillmentOrderRow } from "../../../src/domains/commerce/omsFulfillmentSummary.js";
import {
  classifyOmsOmnipackDispatchHealth,
  type OmsHealthDispatchRefRow,
} from "./omsOmnipackDispatchHealth.js";

const NOW = new Date("2026-06-05T11:00:00.000Z");
// The provider kind this deployment dispatches through, named once for every fixture below.
const DISPATCH_PROVIDER_KIND = "omnipack";

describe("classifyOmsOmnipackDispatchHealth", () => {
  it("waits through the missing-ref grace and fails malformed time toward attention", () => {
    expect(classify({
      fulfillmentOrder: fulfillment({
        created_at: "2026-06-05T10:59:00.000Z",
        updated_at: "2026-06-05T10:59:00.000Z",
      }),
    })).toBeNull();

    expect(classify({
      fulfillmentOrder: fulfillment({ created_at: "invalid", updated_at: "invalid" }),
    })).toEqual({
      healthStatus: "missing_local_commitment",
      reason: "paid_order_missing_dispatch_ref",
      timestamp: "invalid",
    });
  });

  it("ignores non-dispatchable fulfillment states and non-OmniPack obligations", () => {
    expect(classify({ fulfillmentOrder: fulfillment({ status: "handed_over" }) })).toBeNull();
    expect(classify({
      fulfillmentOrder: fulfillment({ provider_kind: "manual" }),
      order: { metadata: { selectedDelivery: { providerKind: "manual" } } },
    })).toBeNull();
  });

  // The shape production actually produces, which no fixture here had. `provider_kind` on a
  // fulfilment row is written by ONE writer, and that writer sets `status = 'label_created'`
  // in the same statement - outside the `created`/`label_pending` window this classifier
  // evaluates. So in reality the column is always null here, the obligation guard was
  // unreachable-true, and a parcel that stranded before dispatch reported `ok`.
  it("names a stranded parcel from the order's delivery selection, with no provider_kind at all", () => {
    expect(classify({
      fulfillmentOrder: fulfillment({ provider_kind: null }),
      order: { metadata: { selectedDelivery: { providerKind: DISPATCH_PROVIDER_KIND } } },
    })).toEqual({
      healthStatus: "missing_local_commitment",
      reason: "paid_order_missing_dispatch_ref",
      timestamp: "2026-06-05T10:00:00.000Z",
    });

    // The runtimeFinalize position is the same fact written later in checkout; the resolver
    // that the dispatch router uses reads both, so the alarm cannot depend on which one won.
    expect(classify({
      fulfillmentOrder: fulfillment({ provider_kind: null }),
      order: { metadata: { runtimeFinalize: { selectedDelivery: { providerKind: DISPATCH_PROVIDER_KIND } } } },
    })).not.toBeNull();

    // And an order this deployment's provider is not responsible for still stays quiet.
    expect(classify({ fulfillmentOrder: fulfillment({ provider_kind: null }), order: { metadata: {} } })).toBeNull();
  });

  it("keeps draft and fresh submission monitor-only but fences a stale submission", () => {
    expect(classify({ dispatchRef: dispatch({ status: "draft" }) })).toBeNull();
    expect(classify({
      dispatchRef: dispatch({ status: "submitting", updated_at: "2026-06-05T10:55:01.000Z" }),
    })).toBeNull();
    expect(classify({
      dispatchRef: dispatch({ status: "submitting", updated_at: "2026-06-05T10:54:59.000Z" }),
    })).toEqual({
      healthStatus: "blocked_uncertain",
      reason: "dispatch_submission_stale",
      timestamp: "2026-06-05T10:54:59.000Z",
    });
  });

  it.each([
    ["uncertain", "blocked_uncertain", "dispatch_outcome_uncertain"],
    ["failed", "needs_attention", "dispatch_failed"],
    ["cancel_requested", "needs_attention", "dispatch_terminal_without_progress"],
    ["cancelled", "needs_attention", "dispatch_terminal_without_progress"],
    ["unexpected", "needs_attention", "dispatch_status_unknown"],
  ] as const)("classifies %s evidence", (status, healthStatus, reason) => {
    expect(classify({ dispatchRef: dispatch({ status }) })).toEqual({
      healthStatus,
      reason,
      timestamp: "2026-06-05T10:20:00.000Z",
    });
  });

  it("requires provider identity before created evidence is healthy", () => {
    expect(classify({
      dispatchRef: dispatch({ status: "created", provider_order_id: null }),
    })).toEqual({
      healthStatus: "needs_attention",
      reason: "dispatch_created_without_provider_order_id",
      timestamp: "2026-06-05T10:20:00.000Z",
    });
    expect(classify({ dispatchRef: dispatch({ status: "created" }) })).toBeNull();
  });
});

function classify(overrides: {
  fulfillmentOrder?: OmsFulfillmentOrderRow;
  order?: { metadata?: unknown };
  dispatchRef?: OmsHealthDispatchRefRow | null;
}) {
  return classifyOmsOmnipackDispatchHealth({
    fulfillmentOrder: overrides.fulfillmentOrder ?? fulfillment(),
    order: overrides.order ?? null,
    dispatchRef: overrides.dispatchRef ?? null,
    now: NOW,
    missingRefGraceSeconds: 30 * 60,
    staleSeconds: 5 * 60,
  });
}

function fulfillment(overrides: Partial<OmsFulfillmentOrderRow> = {}): OmsFulfillmentOrderRow {
  return {
    id: "fulfillment-1",
    order_id: "order-1",
    status: "created",
    provider_kind: DISPATCH_PROVIDER_KIND,
    created_at: "2026-06-05T10:00:00.000Z",
    updated_at: "2026-06-05T10:00:00.000Z",
    ...overrides,
  };
}

function dispatch(overrides: Partial<OmsHealthDispatchRefRow> = {}): OmsHealthDispatchRefRow {
  return {
    id: "dispatch-1",
    fulfillment_order_id: "fulfillment-1",
    provider_order_id: "omnipack-order-1",
    status: "created",
    created_at: "2026-06-05T10:20:00.000Z",
    updated_at: "2026-06-05T10:20:00.000Z",
    ...overrides,
  };
}
