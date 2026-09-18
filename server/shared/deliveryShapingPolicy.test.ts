import { describe, expect, it } from "vitest";

import {
  createSupabaseDeliveryShapingPolicy,
  type DeliveryShapingSupabaseClient,
} from "./deliveryShapingPolicy.js";

type Response = { data: unknown; error: { code?: string; message?: string } | null };

function makeClient(
  responses: Record<string, Response>,
  opts: { throwOn?: string; seen?: string[] } = {},
): DeliveryShapingSupabaseClient {
  let currentKey = "";
  const builder = {
    select() {
      return builder;
    },
    eq(column: string, value: unknown) {
      if (column === "slug") {
        currentKey = String(value);
        opts.seen?.push(currentKey);
      }
      return builder;
    },
    maybeSingle(): PromiseLike<Response> {
      if (opts.throwOn === currentKey) throw new Error("boom");
      return Promise.resolve(responses[currentKey] ?? { data: null, error: null });
    },
  };
  return { from: () => builder };
}

describe("deliveryShapingPolicy.shouldDeliver", () => {
  it("denies when the exact slug control is disabled", async () => {
    const policy = createSupabaseDeliveryShapingPolicy(
      makeClient({ "order-shipped": { data: { enabled: false }, error: null } }),
    );
    expect(await policy.shouldDeliver({ slug: "order-shipped" })).toEqual({ allow: false });
  });

  it("probes the exact slug then the family wildcard, in order", async () => {
    const seen: string[] = [];
    const policy = createSupabaseDeliveryShapingPolicy(
      makeClient(
        {
          "subscription-payment-failed-3": { data: { enabled: true }, error: null },
          "subscription-payment-failed-*": { data: { enabled: false }, error: null },
        },
        { seen },
      ),
    );
    const decision = await policy.shouldDeliver({ slug: "subscription-payment-failed-3" });
    expect(decision).toEqual({ allow: false });
    expect(seen).toEqual(["subscription-payment-failed-3", "subscription-payment-failed-*"]);
  });

  it("allows when no control row exists (fail-open on missing)", async () => {
    const policy = createSupabaseDeliveryShapingPolicy(makeClient({}));
    expect(await policy.shouldDeliver({ slug: "order-shipped" })).toEqual({ allow: true });
  });

  it("allows when the read returns an error (fail-open on error)", async () => {
    const policy = createSupabaseDeliveryShapingPolicy(
      makeClient({ "order-shipped": { data: null, error: { code: "PGRST" } } }),
    );
    expect(await policy.shouldDeliver({ slug: "order-shipped" })).toEqual({ allow: true });
  });

  it("allows when the query throws (fail-open on exception)", async () => {
    const policy = createSupabaseDeliveryShapingPolicy(
      makeClient({}, { throwOn: "order-shipped" }),
    );
    expect(await policy.shouldDeliver({ slug: "order-shipped" })).toEqual({ allow: true });
  });

  it("ignores the inert customerId/now/signal params (same decision)", async () => {
    const policy = createSupabaseDeliveryShapingPolicy(
      makeClient({ "order-shipped": { data: { enabled: false }, error: null } }),
    );
    const withExtras = await policy.shouldDeliver({
      slug: "order-shipped",
      customerId: "cust_1",
      now: new Date(0),
      signal: new AbortController().signal,
    });
    const without = await policy.shouldDeliver({ slug: "order-shipped" });
    expect(withExtras).toEqual(without);
  });
});
