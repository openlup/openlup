import { describe, expect, it, vi } from "vitest";
import {
  StarterPackMarkerError,
  starterPackMarkerSchema,
  type StarterPackMarker,
} from "../../../domains/subscription/starterPackCycle.js";
import {
  createStarterPackCyclePort,
  loadStarterPackState,
  prepareStarterPackCycle,
  type StarterPackDbClient,
} from "./starterPackCycle.js";

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const BASIS = 1;

function marker(overrides: Record<string, unknown> = {}): StarterPackMarker {
  return starterPackMarkerSchema.parse({
    schemaVersion: "1",
    starterIntervalDays: 17,
    basisTemplateVersion: BASIS,
    delivery2: { discountBps: 3500, discountMinor: 3430, basisSubtotalMinor: 9800 },
    graduation: {
      cadenceDays: 28,
      lines: [
        {
          sku: "VEL-LAMB-01",
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
    ...overrides,
  });
}

function makeClient(opts: { row?: unknown; error?: { message?: string } | null } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: { starterGraduation: {} }, error: null });
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq"] as const) builder[fn] = vi.fn().mockReturnValue(builder);
  builder.then = (resolve: (value: unknown) => unknown) =>
    resolve({ data: opts.row === undefined ? [] : opts.row, error: opts.error ?? null });
  const from = vi.fn().mockReturnValue(builder);
  return { client: { rpc, from } as unknown as StarterPackDbClient, rpc, from };
}

describe("loadStarterPackState", () => {
  it("returns a null marker for an ordinary subscription", async () => {
    const { client } = makeClient({
      row: [{ starter_pack: null, template_version: 4, cadence_days: 28 }],
    });
    await expect(loadStarterPackState(client, SUB_ID)).resolves.toEqual({
      marker: null,
      templateVersion: 4,
      cadenceDays: 28,
    });
  });

  it("throws fail-closed on a malformed stored marker", async () => {
    const { client } = makeClient({
      row: [{ starter_pack: { schemaVersion: "1" }, template_version: 1, cadence_days: 17 }],
    });
    await expect(loadStarterPackState(client, SUB_ID)).rejects.toBeInstanceOf(
      StarterPackMarkerError,
    );
  });

  it("throws when the read errors or the row is missing", async () => {
    const errored = makeClient({ row: null, error: { message: "read_failed" } });
    await expect(loadStarterPackState(errored.client, SUB_ID)).rejects.toThrow(/read_failed/);
    const missing = makeClient({ row: [] });
    await expect(loadStarterPackState(missing.client, SUB_ID)).rejects.toThrow(
      /subscription row not found/,
    );
  });
});

describe("prepareStarterPackCycle", () => {
  const state = (over: Partial<{ marker: StarterPackMarker | null; templateVersion: number; cadenceDays: number }> = {}) => ({
    marker: marker(),
    templateVersion: BASIS,
    cadenceDays: 17,
    ...over,
  });

  it("is inert for a subscription without a marker", async () => {
    const { client, rpc } = makeClient();
    await expect(
      prepareStarterPackCycle(client, {
        subscriptionId: SUB_ID,
        cycleNumber: 3,
        state: state({ marker: null }),
        subtotalMinor: 9800,
      }),
    ).resolves.toEqual({
      phase: "none",
      discountTotalGrossMinor: null,
      reload: false,
      provenance: null,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns the delivery-2 discount and its timestamp-free provenance", async () => {
    const { client, rpc } = makeClient();
    const result = await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 2,
      state: state(),
      subtotalMinor: 9800,
    });
    expect(result).toEqual({
      phase: "delivery2",
      discountTotalGrossMinor: 3430,
      reload: false,
      provenance: {
        starterPack: {
          reasonCode: "starter_pack_delivery_2",
          discountMinor: 3430,
          basisTemplateVersion: BASIS,
        },
      },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("invokes the graduation RPC once with a deterministic key and asks for a reload", async () => {
    const { client, rpc } = makeClient();
    const result = await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 3,
      state: state(),
      subtotalMinor: 9800,
    });
    expect(result).toEqual({
      phase: "graduate_full",
      discountTotalGrossMinor: null,
      reload: true,
      provenance: null,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("subscription_apply_starter_graduation", {
      p_subscription_id: SUB_ID,
      p_idempotency_key: `starter-graduation:${SUB_ID}:${BASIS}`,
      p_mode: "full",
    });
  });

  it("re-driving after graduation is a no-op that never calls the RPC again", async () => {
    const { client, rpc } = makeClient();
    // Post-graduation state: template moved and cadence is now the steady 28.
    const result = await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 3,
      state: state({ templateVersion: BASIS + 1, cadenceDays: 28 }),
      subtotalMinor: 9800,
    });
    expect(result.phase).toBe("none");
    expect(result.reload).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses the cadence-only mode and its own key namespace for a moved template", async () => {
    const { client, rpc } = makeClient();
    const result = await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 4,
      state: state({ templateVersion: BASIS + 1, cadenceDays: 17 }),
      subtotalMinor: 9800,
    });
    expect(result.phase).toBe("graduate_cadence_only");
    expect(result.reload).toBe(true);
    expect(rpc).toHaveBeenCalledWith("subscription_apply_starter_graduation", {
      p_subscription_id: SUB_ID,
      p_idempotency_key: `starter-cadence-normalize:${SUB_ID}:${BASIS}`,
      p_mode: "cadence_only",
    });
  });

  it("throws when the graduation RPC fails", async () => {
    const { client, rpc } = makeClient();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "open_cycle" } });
    await expect(
      prepareStarterPackCycle(client, {
        subscriptionId: SUB_ID,
        cycleNumber: 3,
        state: state(),
        subtotalMinor: 9800,
      }),
    ).rejects.toThrow(/subscription_apply_starter_graduation failed: open_cycle/);
  });
});

/**
 * P1-1 regression: the TOCTOU between a customer edit and the graduation RPC.
 *
 * The phase is derived from a `template_version` read that is older than the
 * RPC's own `FOR UPDATE` read. When an edit lands in the gap the RPC declines
 * with `template_version_moved` WITHOUT touching cadence, so the subscription
 * would keep renewing at the starter interval with a full steady package. The
 * builder must notice the declined business result — it used to look only at
 * the transport error — and normalize the cadence itself.
 */
describe("prepareStarterPackCycle - graduation TOCTOU recovery", () => {
  // Local copy of the sibling block's helper: that one is scoped to its own
  // describe and moving it would edit a block this wave has no business in.
  const state = (over: Partial<{ marker: StarterPackMarker | null; templateVersion: number; cadenceDays: number }> = {}) => ({
    marker: marker(),
    templateVersion: BASIS,
    cadenceDays: 17,
    ...over,
  });
  const declined = (reason: string) => ({
    data: { contractVersion: "subscription.starter_graduation.v1", starterGraduation: { applied: false, reason } },
    error: null,
  });

  function clientWithFreshState(freshRow: Record<string, unknown>) {
    const made = makeClient({ row: [freshRow] });
    made.rpc.mockResolvedValueOnce(declined("template_version_moved"));
    return made;
  }

  it("follows a template_version_moved no-op with a cadence_only call when the cadence is still the starter interval", async () => {
    // Fresh re-read: the customer's edit bumped template_version but left the
    // acquisition cadence of 17 days, which nobody chose.
    const { client, rpc, from } = clientWithFreshState({
      starter_pack: marker(),
      template_version: BASIS + 1,
      cadence_days: 17,
    });

    const result = await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 3,
      state: state(),
      subtotalMinor: 9800,
    });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "subscription_apply_starter_graduation", {
      p_subscription_id: SUB_ID,
      p_idempotency_key: `starter-graduation:${SUB_ID}:${BASIS}`,
      p_mode: "full",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "subscription_apply_starter_graduation", {
      p_subscription_id: SUB_ID,
      p_idempotency_key: `starter-cadence-normalize:${SUB_ID}:${BASIS}`,
      p_mode: "cadence_only",
    });
    // The decision is taken on a FRESH read, not on the stale input state.
    expect(from).toHaveBeenCalledWith("subscriptions");
    expect(result.reload).toBe(true);
  });

  it("does NOT call again when the fresh read shows the customer already picked a normal cadence", async () => {
    const { client, rpc } = clientWithFreshState({
      starter_pack: marker(),
      template_version: BASIS + 1,
      cadence_days: 28,
    });

    await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 3,
      state: state(),
      subtotalMinor: 9800,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does NOT call again when the marker was cleared between the two reads", async () => {
    const { client, rpc } = clientWithFreshState({
      starter_pack: null,
      template_version: BASIS + 1,
      cadence_days: 17,
    });

    await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 3,
      state: state(),
      subtotalMinor: 9800,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cadence_already_normal"],
    ["not_a_starter_subscription"],
  ])("proceeds without recovery on the benign declined reason %s", async (reason) => {
    const { client, rpc, from } = makeClient();
    rpc.mockResolvedValueOnce(declined(reason));

    const result = await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 3,
      state: state(),
      subtotalMinor: 9800,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
    expect(result.reload).toBe(true);
  });

  it("proceeds without recovery on an unrecognised future reason", async () => {
    const { client, rpc, from } = makeClient();
    rpc.mockResolvedValueOnce(declined("some_reason_added_later"));

    await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 3,
      state: state(),
      subtotalMinor: 9800,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("never recovers after a cadence_only call, so there is no retry loop", async () => {
    const { client, rpc } = makeClient({
      row: [{ starter_pack: marker(), template_version: BASIS + 1, cadence_days: 17 }],
    });
    rpc.mockResolvedValueOnce(declined("template_version_moved"));

    await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID,
      cycleNumber: 4,
      // Already on the cadence_only arm: a declined result must not recurse.
      state: state({ templateVersion: BASIS + 1, cadenceDays: 17 }),
      subtotalMinor: 9800,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable or applied result as applied (pre-fix behaviour preserved)", async () => {
    const { client, rpc, from } = makeClient();
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await prepareStarterPackCycle(client, {
      subscriptionId: SUB_ID, cycleNumber: 3, state: state(), subtotalMinor: 9800,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();

    const applied = makeClient();
    applied.rpc.mockResolvedValueOnce({
      data: { starterGraduation: { applied: true, reason: "cadence_normalized" } },
      error: null,
    });
    await prepareStarterPackCycle(applied.client, {
      subscriptionId: SUB_ID, cycleNumber: 3, state: state(), subtotalMinor: 9800,
    });
    expect(applied.rpc).toHaveBeenCalledTimes(1);
    expect(applied.from).not.toHaveBeenCalled();
  });
});

describe("createStarterPackCyclePort", () => {
  it("exposes the two neutral operations bound to one client", async () => {
    const { client, from, rpc } = makeClient({
      row: [{ starter_pack: null, template_version: 4, cadence_days: 28 }],
    });
    const port = createStarterPackCyclePort(client);

    await expect(port.loadStarterPackState(SUB_ID)).resolves.toEqual({
      marker: null,
      templateVersion: 4,
      cadenceDays: 28,
    });
    expect(from).toHaveBeenCalledWith("subscriptions");

    await expect(
      port.prepareStarterPackCycle({
        subscriptionId: SUB_ID,
        cycleNumber: 2,
        state: { marker: marker(), templateVersion: BASIS, cadenceDays: 17 },
        subtotalMinor: 9800,
      }),
    ).resolves.toMatchObject({ phase: "delivery2", discountTotalGrossMinor: 3430 });
    expect(rpc).not.toHaveBeenCalled();
  });
});
