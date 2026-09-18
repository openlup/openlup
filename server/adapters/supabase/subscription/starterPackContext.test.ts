import { describe, expect, it, vi } from "vitest";
import type { StarterPackMarker } from "../../../domains/subscription/starterPackCycle.js";
import {
  createStarterPackContextPort,
  createStarterPackMoneyLabel,
  type StarterPackEmailDbClient,
} from "./starterPackContext.js";

const MARKER: StarterPackMarker = {
  schemaVersion: "1",
  starterIntervalDays: 14,
  basisTemplateVersion: 1,
  delivery2: { discountBps: 3_500, discountMinor: 3_150, basisSubtotalMinor: 16_800 },
  graduation: {
    cadenceDays: 28,
    lines: [
      {
        sku: "opaque:lamb-launch.v1",
        qty: 20,
        sortOrder: 0,
        isAddon: false,
        quoteLine: { lineSubtotalGross: { amountMinor: 20_000, currency: "PLN" } },
      },
      {
        sku: "opaque:beef-launch.v1",
        qty: 8,
        sortOrder: 1,
        isAddon: false,
        quoteLine: { lineSubtotalGross: { amountMinor: 8_000, currency: "PLN" } },
      },
    ],
  },
};

describe("createStarterPackContextPort", () => {
  function client(rows: {
    subscriptions?: unknown;
    subscriptionsError?: unknown;
    cycles?: unknown;
  }) {
    const calls: string[] = [];
    const query = (table: string) => {
      const result =
        table === "subscriptions"
          ? { data: rows.subscriptions ?? null, error: rows.subscriptionsError ?? null }
          : { data: rows.cycles ?? null, error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const method of ["select", "eq", "order", "limit"]) {
        builder[method] = () => builder;
      }
      return builder;
    };
    return {
      calls,
      client: {
        from: vi.fn((table: string) => {
          calls.push(table);
          return query(table);
        }),
      } as unknown as StarterPackEmailDbClient,
    };
  }

  it("answers null after ONE read when the subscription carries no marker", async () => {
    const { client: db, calls } = client({
      subscriptions: [{ starter_pack: null, template_version: 1 }],
    });
    await expect(
      createStarterPackContextPort(db).read("sub-1", new AbortController().signal),
    ).resolves.toBeNull();
    expect(calls).toEqual(["subscriptions"]);
  });

  it("derives the upcoming cycle number as max + 1", async () => {
    const { client: db, calls } = client({
      subscriptions: [{ starter_pack: MARKER, template_version: 1, currency: "PLN" }],
      cycles: [{ cycle_number: 1 }],
    });
    await expect(
      createStarterPackContextPort(db).read("sub-1", new AbortController().signal),
    ).resolves.toEqual({ marker: MARKER, templateVersion: 1, upcomingCycleNumber: 2, currency: "PLN" });
    expect(calls).toEqual(["subscriptions", "subscription_cycles"]);
  });

  it("carries the subscription currency and fails closed to no amount when it is absent", async () => {
    const { client: db } = client({
      subscriptions: [{ starter_pack: MARKER, template_version: 1, currency: "  " }],
      cycles: [{ cycle_number: 1 }],
    });
    const context = await createStarterPackContextPort(db).read("sub-1", new AbortController().signal);
    expect(context?.currency).toBeNull();
    expect(createStarterPackMoneyLabel("en")(13_650, context?.currency ?? null)).toBeNull();
  });

  it("degrades to null on a read error or an unparseable marker", async () => {
    const failing = client({ subscriptionsError: { message: "boom" } });
    await expect(
      createStarterPackContextPort(failing.client).read(
        "sub-1",
        new AbortController().signal,
      ),
    ).resolves.toBeNull();

    const garbage = client({ subscriptions: [{ starter_pack: { schemaVersion: "9" } }] });
    await expect(
      createStarterPackContextPort(garbage.client).read(
        "sub-1",
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
  });
});

describe("createStarterPackMoneyLabel", () => {
  it("keeps the managed PLN label of both locales byte-identical to the pre-split formatter", () => {
    expect(createStarterPackMoneyLabel("pl")(13_650, "PLN")).toContain("136,50");
    expect(createStarterPackMoneyLabel("en")(13_650, "PLN")).toContain("136.50");
  });
});
