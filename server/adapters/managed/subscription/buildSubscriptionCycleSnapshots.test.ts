import { describe, expect, it, vi } from "vitest";
import { rowErrorReasonKey } from "../../../../api/_cron/subscription-renewal-aggregation.js";
import { createStarterPackCyclePort } from "../../supabase/subscription/starterPackCycle.js";
import {
  buildSubscriptionCycleSnapshots,
  SubscriptionCycleSnapshotError,
  type SubscriptionCycleSnapshotClient,
} from "./buildSubscriptionCycleSnapshots.js";

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const SCHEDULED_AT = "2026-06-09T12:00:00Z";

function quoteLine(opts: { sku?: string; unitPriceMinor?: number; quantity?: number } = {}) {
  const sku = opts.sku ?? "VEL-LAMB-01";
  const quantity = opts.quantity ?? 2;
  const unitPriceMinor = opts.unitPriceMinor ?? 4900;
  const subtotalMinor = unitPriceMinor * quantity;
  const netMinor = Math.round((subtotalMinor * 10000) / (10000 + 800));
  const vatMinor = subtotalMinor - netMinor;
  return {
    sku,
    productSlug: "lamb",
    quantity,
    unitPriceGross: { amountMinor: unitPriceMinor, currency: "PLN" },
    lineSubtotalGross: { amountMinor: subtotalMinor, currency: "PLN" },
    tax: {
      included: true,
      country: "PL",
      category: "pet_food",
      vatRateBps: 800,
      legalBasis: "PL VAT Annex 3 item 10c",
      netAmount: { amountMinor: netMinor, currency: "PLN" },
      vatAmount: { amountMinor: vatMinor, currency: "PLN" },
      grossAmount: { amountMinor: subtotalMinor, currency: "PLN" },
    },
  };
}

function templateRpcReturn(): Record<string, unknown> {
  return {
    cadence_days: 28,
    currency: "PLN",
    region_code: "PL",
    edit_window_hours: 72,
    size_constraint: {},
    lines: [
      { variant_id: "v-1", qty: 2, sort_order: 0, is_addon: false },
    ],
  };
}

function makeClient(opts: {
  templateData?: unknown;
  templateError?: { message?: string } | null;
  subscriptionLinesData?: unknown;
  subscriptionLinesError?: { message?: string } | null;
  subscriptionCyclesData?: unknown;
  subscriptionCyclesError?: { message?: string } | null;
  // Harness extension only: the builder now reads the subscription's starter
  // state. The default row is the ordinary no-marker subscription, so every
  // pre-existing case behaves exactly as before.
  subscriptionsData?: unknown;
  graduationTemplateData?: unknown;
  graduationLinesData?: unknown;
  // The graduation RPC's RAISE arrives here as a transport error carrying the
  // raised condition in its message, which is the only place the condition
  // exists on this side of PostgREST.
  graduationRpcError?: { message?: string };
}): SubscriptionCycleSnapshotClient {
  let templateReads = 0;
  let lineReads = 0;
  const rpc = vi.fn().mockImplementation((name: string) => {
    if (name === "subscription_current_template_snapshot") {
      templateReads += 1;
      const graduated = templateReads > 1 ? opts.graduationTemplateData : undefined;
      return Promise.resolve({
        data: graduated ?? opts.templateData ?? templateRpcReturn(),
        error: opts.templateError ?? null,
      });
    }
    if (name === "subscription_apply_starter_graduation") {
      if (opts.graduationRpcError) {
        return Promise.resolve({ data: null, error: opts.graduationRpcError });
      }
      return Promise.resolve({ data: { starterGraduation: { applied: true } }, error: null });
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "subscriptions") {
      return thenableBuilder({
        data: opts.subscriptionsData ?? [
          { starter_pack: null, template_version: 1, cadence_days: 28 },
        ],
        error: null,
      });
    }
    if (table === "subscription_lines") {
      lineReads += 1;
      if (lineReads > 1 && opts.graduationLinesData) {
        return thenableBuilder({ data: opts.graduationLinesData, error: null });
      }
      return thenableBuilder({
        data: opts.subscriptionLinesData ?? [
          {
            variant_id: "v-1",
            qty: 2,
            sort_order: 0,
            line_metadata: {
              initialOrderId: "00000000-0000-4000-8000-0000000000aa",
              initialOrderItemId: "00000000-0000-4000-8000-0000000000bb",
              productSnapshot: {
                sku: "VEL-LAMB-01",
                productSlug: "lamb",
                quoteLine: quoteLine(),
                source: "commerce.order_draft.bff.v0",
              },
              source: "subscription.activation.hidden.v0",
            },
          },
        ],
        error: opts.subscriptionLinesError ?? null,
      });
    }
    if (table === "subscription_cycles") {
      return thenableBuilder({
        data: opts.subscriptionCyclesData ?? [],
        error: opts.subscriptionCyclesError ?? null,
      });
    }
    throw new Error(`unexpected from ${table}`);
  });

  // The starter-pack half of the builder now arrives through the neutral
  // `StarterPackCyclePort`; the managed adapter is composed onto the fake store
  // exactly as production composes it, so every expectation below is unchanged.
  return Object.assign(
    { rpc, from },
    createStarterPackCyclePort({ rpc, from } as never),
  ) as unknown as SubscriptionCycleSnapshotClient;
}

function thenableBuilder(result: { data: unknown; error: { message?: string } | null }) {
  // Each `.select/.eq/.order` call returns the same thenable so the awaited
  // value is the supplied result.
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "order"] as const) {
    builder[fn] = vi.fn().mockReturnValue(builder);
  }
  builder.then = (resolve: (value: typeof result) => unknown) => resolve(result);
  return builder as never;
}

describe("buildSubscriptionCycleSnapshots", () => {
  it("starts every independent snapshot read before a pending template read resolves", async () => {
    let resolveTemplate!: (value: { data: unknown; error: null }) => void;
    const templatePending = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveTemplate = resolve;
    });
    const client = makeClient({}) as SubscriptionCycleSnapshotClient & { from: ReturnType<typeof vi.fn> };
    client.rpc = vi.fn(() => templatePending);

    const pending = buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    // All three work items begin before the first one settles. The cycle and
    // line builders are still queried even though template data is pending.
    expect(client.from).toHaveBeenCalledWith("subscription_lines");
    expect(client.from).toHaveBeenCalledWith("subscription_cycles");

    resolveTemplate({ data: templateRpcReturn(), error: null });
    await expect(pending).resolves.toMatchObject({ cycleNumber: 1 });
  });

  it("derives templateSnapshot from RPC and lines from subscription_lines metadata", async () => {
    const client = makeClient({});

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    expect(result.cycleNumber).toBe(1);
    expect(result.templateSnapshot).toMatchObject({
      cadence_days: 28,
      currency: "PLN",
      lines: expect.any(Array),
    });

    expect(result.orderSnapshot).toMatchObject({
      contractVersion: "commerce.v0",
      source: "subscription.own_engine.v0",
      status: "pending_payment",
      paymentStatus: "pending",
      currency: "PLN",
      taxIncluded: true,
    });

    const orderSnapshot = result.orderSnapshot as Record<string, unknown>;
    expect(Array.isArray(orderSnapshot.lines)).toBe(true);
    expect((orderSnapshot.lines as unknown[]).length).toBe(1);
    const totals = orderSnapshot.totals as Record<string, { amountMinor: number }>;
    expect(totals.subtotalGross.amountMinor).toBe(9800);
    expect(totals.totalGross.amountMinor).toBe(9800);
    expect(totals.netTotal.amountMinor + totals.taxTotal.amountMinor).toBe(9800);

    expect(result.pricingSnapshot).toMatchObject({
      contractVersion: "commerce.v0",
      source: "subscription.own_engine.v0",
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
      cycleNumber: 1,
    });
  });

  it("copies an accepted custom mix exactly into the next renewal order snapshot", async () => {
    const lines = [
      renewalLine("v-lamb", 5, 0, "VEL-LAMB-01", 4900),
      renewalLine("v-beef", 3, 1, "VEL-BEEF-01", 5100),
    ];
    const client = makeClient({
      templateData: {
        ...templateRpcReturn(),
        cadence_days: 30,
        size_constraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 },
        lines: lines.map((line) => ({
          variant_id: line.variant_id,
          qty: line.qty,
          sort_order: line.sort_order,
          is_addon: false,
        })),
      },
      subscriptionLinesData: lines,
    });

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    expect(result.templateSnapshot).toMatchObject({
      cadence_days: 30,
      size_constraint: { kind: "feeding_days", value: 14 },
      lines: [
        expect.objectContaining({ variant_id: "v-lamb", qty: 5 }),
        expect.objectContaining({ variant_id: "v-beef", qty: 3 }),
      ],
    });
    expect((result.orderSnapshot.lines as Array<{ sku: string; quantity: number }>).map(
      ({ sku, quantity }) => ({ sku, quantity }),
    )).toEqual([
      { sku: "VEL-LAMB-01", quantity: 5 },
      { sku: "VEL-BEEF-01", quantity: 3 },
    ]);
  });

  it("increments cycle number based on existing subscription_cycles rows", async () => {
    const client = makeClient({
      subscriptionCyclesData: [{ cycle_number: 4 }, { cycle_number: 3 }],
    });

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    expect(result.cycleNumber).toBe(5);
    expect(result.retryAttempt).toBe(0);
    expect(result.providerAttemptSequence).toBe(0);
  });

  it("reuses the existing cycle's cycle_number + retry_attempt when re-driving a retry (CJ01-P)", async () => {
    // cycle 1 (paid) + cycle 2 (retry_scheduled at SCHEDULED_AT). Recomputing
    // max+1 here would mint cycleNumber 3 and corrupt the cycle-order
    // idempotency fingerprint → conflict. We must reuse cycle_number 2.
    const client = makeClient({
      subscriptionCyclesData: [
        { cycle_number: 2, scheduled_at: SCHEDULED_AT, retry_attempt: 1, provider_attempt_sequence: 2 },
        { cycle_number: 1, scheduled_at: "2026-05-12T12:00:00Z", retry_attempt: 0 },
      ],
    });

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    expect(result.cycleNumber).toBe(2);
    expect(result.retryAttempt).toBe(1);
    expect(result.providerAttemptSequence).toBe(2);
    expect(result.pricingSnapshot).toMatchObject({ cycleNumber: 2 });
  });

  it("matches the retry cycle by scheduled_at even under a different timestamp serialization", async () => {
    // The due-RPC may echo scheduled_at with a +00:00 offset; the compare is by
    // epoch millis so it still resolves to the persisted cycle.
    const client = makeClient({
      subscriptionCyclesData: [
        { cycle_number: 2, scheduled_at: "2026-06-09T12:00:00+00:00", retry_attempt: 2 },
        { cycle_number: 1, scheduled_at: "2026-05-12T12:00:00Z", retry_attempt: 0 },
      ],
    });

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT, // "2026-06-09T12:00:00Z"
    });

    expect(result.cycleNumber).toBe(2);
    expect(result.retryAttempt).toBe(2);
    expect(result.providerAttemptSequence).toBe(0);
  });

  it("throws when the subscription_cycles read fails", async () => {
    const client = makeClient({
      subscriptionCyclesData: null,
      subscriptionCyclesError: { message: "cycles_read_failed" },
    });

    await expect(
      buildSubscriptionCycleSnapshots(client, {
        subscriptionId: SUB_ID,
        scheduledAt: SCHEDULED_AT,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCycleSnapshotError);
  });

  it("throws when the subscription has no subscription_lines rows", async () => {
    const client = makeClient({ subscriptionLinesData: [] });

    await expect(
      buildSubscriptionCycleSnapshots(client, {
        subscriptionId: SUB_ID,
        scheduledAt: SCHEDULED_AT,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCycleSnapshotError);
  });

  it("throws when template RPC errors", async () => {
    const client = makeClient({
      templateData: null,
      templateError: { message: "rpc_failed" },
    });

    await expect(
      buildSubscriptionCycleSnapshots(client, {
        subscriptionId: SUB_ID,
        scheduledAt: SCHEDULED_AT,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCycleSnapshotError);
  });

  it("throws when quoteLine is missing from product snapshot", async () => {
    const client = makeClient({
      subscriptionLinesData: [
        {
          variant_id: "v-1",
          qty: 2,
          sort_order: 0,
          line_metadata: {
            productSnapshot: { sku: "X", productSlug: "x" },
          },
        },
      ],
    });

    await expect(
      buildSubscriptionCycleSnapshots(client, {
        subscriptionId: SUB_ID,
        scheduledAt: SCHEDULED_AT,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCycleSnapshotError);
  });

  it("produces a deterministic snapshot for the same inputs", async () => {
    const client = makeClient({});

    const first = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });
    const second = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    expect(JSON.stringify(first.orderSnapshot)).toEqual(JSON.stringify(second.orderSnapshot));
    expect(JSON.stringify(first.pricingSnapshot)).toEqual(JSON.stringify(second.pricingSnapshot));
    expect(JSON.stringify(first.templateSnapshot)).toEqual(JSON.stringify(second.templateSnapshot));
  });

  it("discounts delivery 2 of a starter-pack subscription and records why", async () => {
    const client = makeClient({
      subscriptionsData: [{ starter_pack: starterMarker(), template_version: 1, cadence_days: 17 }],
      subscriptionCyclesData: [{ cycle_number: 1 }],
    });

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    expect(result.cycleNumber).toBe(2);
    const totals = (result.orderSnapshot as Record<string, unknown>).totals as Record<
      string,
      { amountMinor: number }
    >;
    expect(totals.subtotalGross.amountMinor).toBe(9800);
    expect(totals.discountTotalGross.amountMinor).toBe(3430);
    expect(totals.totalGross.amountMinor).toBe(6370);
    expect(totals.netTotal.amountMinor + totals.taxTotal.amountMinor).toBe(6370);
    expect(result.pricingSnapshot.provenance).toEqual({
      starterPack: {
        reasonCode: "starter_pack_delivery_2",
        discountMinor: 3430,
        basisTemplateVersion: 1,
      },
    });
  });

  it("graduates at cycle 3 and rebuilds from the post-graduation template", async () => {
    const graduatedLine = renewalLine("v-beef", 8, 0, "VEL-BEEF-01", 1340);
    const client = makeClient({
      subscriptionsData: [{ starter_pack: starterMarker(), template_version: 1, cadence_days: 17 }],
      subscriptionCyclesData: [{ cycle_number: 2 }, { cycle_number: 1 }],
      graduationTemplateData: {
        ...templateRpcReturn(),
        cadence_days: 28,
        lines: [{ variant_id: "v-beef", qty: 8, sort_order: 0, is_addon: false }],
      },
      graduationLinesData: [graduatedLine],
    });

    const result = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
    });

    expect(result.cycleNumber).toBe(3);
    expect(client.rpc).toHaveBeenCalledWith("subscription_apply_starter_graduation", {
      p_subscription_id: SUB_ID,
      p_idempotency_key: `starter-graduation:${SUB_ID}:1`,
      p_mode: "full",
    });
    // Post-graduation template and lines, not the acquisition ones.
    expect(result.templateSnapshot).toMatchObject({ cadence_days: 28 });
    expect(
      (result.orderSnapshot.lines as Array<{ sku: string; quantity: number }>).map(
        ({ sku, quantity }) => ({ sku, quantity }),
      ),
    ).toEqual([{ sku: "VEL-BEEF-01", quantity: 8 }]);
    const totals = (result.orderSnapshot as Record<string, unknown>).totals as Record<
      string,
      { amountMinor: number }
    >;
    // Graduation is not a discounted delivery: the steady plan pays list.
    expect(totals.discountTotalGross.amountMinor).toBe(0);
    expect(totals.totalGross.amountMinor).toBe(8 * 1340);
    expect(result.pricingSnapshot.provenance).toBeUndefined();
  });

  // SR-1 REQ-2. `rowErrorReasonKey` is the cron's own normalizer: it keys the
  // durable `row_errors:<key>=<n>` summary — which becomes the run's `error`
  // field — on the text after the LAST ": " in the thrown message. Running the
  // real helper here is what proves the attribution survives that trip rather
  // than only reading well in the exception.
  it.each([
    ["subscription_starter_graduation_open_cycle", "open_cycle"],
    ["subscription_starter_graduation_unknown_sku: VEL-BEEF-01", "unknown_sku"],
    ["upstream connect error or disconnect/reset before headers", "other"],
  ])("attributes a raised graduation (%s) to the subscription and the condition", async (raised, condition) => {
    const client = makeClient({
      subscriptionsData: [{ starter_pack: starterMarker(), template_version: 1, cadence_days: 17 }],
      subscriptionCyclesData: [{ cycle_number: 2 }, { cycle_number: 1 }],
      graduationRpcError: { message: raised },
    });

    const error = await buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID, scheduledAt: SCHEDULED_AT,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SubscriptionCycleSnapshotError);
    const message = (error as SubscriptionCycleSnapshotError).message;
    // The raw transport text is kept, bracketed ahead of the attribution.
    expect(message).toContain(raised);
    expect(rowErrorReasonKey(message)).toBe(`starter_graduation_${condition}_${SUB_ID}`);
    expect(rowErrorReasonKey(message).length).toBeLessThanOrEqual(80);
  });

  // SR-1 REQ-3. Pins existing behaviour, and does not change it: the builder
  // throws BEFORE it can hand snapshots to `createCycleOrder`, which is the
  // only writer of the cycle row — and `next_cycle_at` moves only when a
  // payment reaches its paid terminal
  // (`commerce_payment_control_apply_before_sub_lock`). So a failed graduation
  // consumes nothing: the subscription is still due on the next tick, and the
  // cycle it would have skipped is retried rather than lost.
  it("writes nothing when a graduation raises, so the due row survives for the next tick", async () => {
    const client = makeClient({
      subscriptionsData: [{ starter_pack: starterMarker(), template_version: 1, cadence_days: 17 }],
      subscriptionCyclesData: [{ cycle_number: 2 }, { cycle_number: 1 }],
      graduationRpcError: { message: "subscription_starter_graduation_open_cycle" },
    });

    await expect(buildSubscriptionCycleSnapshots(client, {
      subscriptionId: SUB_ID, scheduledAt: SCHEDULED_AT,
    })).rejects.toBeInstanceOf(SubscriptionCycleSnapshotError);

    // No snapshots were returned, so no caller could reach the cycle-order RPC;
    // and the builder itself issued no write of any kind.
    const rpcNames = (client.rpc as ReturnType<typeof vi.fn>).mock.calls.map(([name]) => name);
    expect(rpcNames).toEqual([
      "subscription_current_template_snapshot", "subscription_apply_starter_graduation",
    ]);
    expect(rpcNames).not.toContain("subscription_create_cycle_order_with_outbox");
  });
});

function starterMarker() {
  return {
    schemaVersion: "1",
    starterIntervalDays: 17,
    basisTemplateVersion: 1,
    delivery2: { discountBps: 3500, discountMinor: 3430, basisSubtotalMinor: 9800 },
    graduation: {
      cadenceDays: 28,
      lines: [
        {
          sku: "VEL-BEEF-01",
          qty: 8,
          sortOrder: 0,
          isAddon: false,
          quoteLine: {
            unitPriceGross: { amountMinor: 1340, currency: "PLN" },
            lineSubtotalGross: { amountMinor: 10720, currency: "PLN" },
          },
        },
      ],
    },
  };
}

function renewalLine(
  variantId: string,
  qty: number,
  sortOrder: number,
  sku: string,
  unitPriceMinor: number,
) {
  return {
    variant_id: variantId,
    qty,
    sort_order: sortOrder,
    line_metadata: {
      productSnapshot: {
        sku,
        productSlug: sku.toLowerCase(),
        quoteLine: quoteLine({ sku, quantity: qty, unitPriceMinor }),
      },
    },
  };
}
