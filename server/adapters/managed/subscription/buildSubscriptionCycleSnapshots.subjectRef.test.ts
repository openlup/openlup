import { describe, expect, it, vi } from "vitest";
import { COMMERCE_CURRENCIES } from "../../../../src/domains/commerce/types.js";
import { createStarterPackCyclePort } from "../../supabase/subscription/starterPackCycle.js";
import { buildSubscriptionCycleSnapshots } from "./buildSubscriptionCycleSnapshots.js";

// Client type derived from the builder signature so this file adds no
// provider-token occurrences to the neutrality families.
type SnapshotDbClient = Parameters<typeof buildSubscriptionCycleSnapshots>[0];

/**
 * E9 characterization — pins that the persisted template snapshot builder passes
 * the `subscription_current_template_snapshot` RPC output through byte-for-byte.
 *
 * The DB guard `subscription_guard_payment_pending_cycle_template`
 * (migration `20260605144000_subscription_cycle_template_snapshot_guard.sql`)
 * rejects a persisted cycle whose `template_snapshot` is `DISTINCT FROM` the
 * RPC-rebuilt snapshot (deep JSONB equality over a FIXED key set that contains
 * neither the legacy alias field NOR `subject_ref`). Adding `subject_ref` to the shared TS
 * type must therefore never leak into this builder's output. This test fails
 * loudly if any extra key (subject_ref, the legacy alias, etc.) is injected into the
 * persisted template snapshot — the cl2 stop condition
 * `stop-if-persisted-snapshot-bytes-change`.
 */

// The commerce money schema admits exactly the canonical enum; sourcing the
// value from the enum keeps this characterization locale-agnostic.
const CCY = COMMERCE_CURRENCIES[0];

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const SCHEDULED_AT = "2026-06-09T12:00:00Z";

// The exact key set the guard's `subscription_current_template_snapshot`
// jsonb_build_object produces — no subject/legacy-alias reference key.
function templateRpcReturn(): Record<string, unknown> {
  return {
    cadence_days: 28,
    currency: CCY,
    region_code: "DE",
    edit_window_hours: 72,
    size_constraint: {},
    lines: [{ variant_id: "v-1", qty: 2, sort_order: 0, is_addon: false }],
  };
}

function quoteLine() {
  const quantity = 2;
  const unitPriceMinor = 4900;
  const subtotalMinor = unitPriceMinor * quantity;
  const netMinor = Math.round((subtotalMinor * 10000) / (10000 + 800));
  const vatMinor = subtotalMinor - netMinor;
  return {
    sku: "SKU-NEUTRAL-01",
    productSlug: "lamb",
    quantity,
    unitPriceGross: { amountMinor: unitPriceMinor, currency: CCY },
    lineSubtotalGross: { amountMinor: subtotalMinor, currency: CCY },
    tax: {
      included: true,
      country: "DE",
      category: "general_goods",
      vatRateBps: 800,
      legalBasis: "DE VAT standard rate",
      netAmount: { amountMinor: netMinor, currency: CCY },
      vatAmount: { amountMinor: vatMinor, currency: CCY },
      grossAmount: { amountMinor: subtotalMinor, currency: CCY },
    },
  };
}

function thenableBuilder(result: { data: unknown; error: null }) {
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "order"] as const) {
    builder[fn] = vi.fn().mockReturnValue(builder);
  }
  builder.then = (resolve: (value: typeof result) => unknown) => resolve(result);
  return builder as never;
}

function makeClient(template: Record<string, unknown>): SnapshotDbClient {
  const rpc = vi.fn().mockImplementation((name: string) => {
    if (name === "subscription_current_template_snapshot") {
      return Promise.resolve({ data: template, error: null });
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "subscription_lines") {
      return thenableBuilder({
        data: [
          {
            variant_id: "v-1",
            qty: 2,
            sort_order: 0,
            line_metadata: {
              productSnapshot: {
                sku: "SKU-NEUTRAL-01",
                productSlug: "lamb",
                quoteLine: quoteLine(),
              },
            },
          },
        ],
        error: null,
      });
    }
    if (table === "subscription_cycles") {
      return thenableBuilder({ data: [], error: null });
    }
    if (table === "subscriptions") {
      // Starter-pack state read added by #2377 — inactive marker, matching template.
      return thenableBuilder({
        data: [{ starter_pack: null, template_version: 1, cadence_days: 28 }],
        error: null,
      });
    }
    throw new Error(`unexpected from ${table}`);
  });
  // Managed starter-pack port composed onto the fake store, as production does.
  return Object.assign(
    { rpc, from },
    createStarterPackCyclePort({ rpc, from } as never),
  ) as unknown as SnapshotDbClient;
}

describe("buildSubscriptionCycleSnapshots subject_ref neutrality (E9)", () => {
  it("returns the RPC template snapshot with an unchanged key set (no subject_ref or legacy alias injected)", async () => {
    const template = templateRpcReturn();
    const client = makeClient(template);

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    // Deep equality: the persisted template snapshot is exactly the RPC output.
    expect(result.templateSnapshot).toEqual(template);
    // Key set is frozen — the guard compares deep JSONB equality.
    expect(Object.keys(result.templateSnapshot).sort()).toEqual(
      ["cadence_days", "currency", "edit_window_hours", "lines", "region_code", "size_constraint"].sort(),
    );
    expect(result.templateSnapshot).not.toHaveProperty("subject_ref");
    // The frozen key-set assertion above already proves NO other key (the legacy
    // alias included) can be injected without failing this test.
  });
});
