import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { applyEdit, readSubscriptionAndLines } from "./subscriptionRepriceData.js";

describe("subscriptionRepriceData helpers", () => {
  it("applyEdit swaps a recipe variant in place and rejects an unknown from-variant", () => {
    const lines = [{ lineId: "l1", variantId: "a", quantity: 2, isAddon: false, sortOrder: 1 }];
    expect(applyEdit("swap_recipe", { fromVariantId: "a", toVariantId: "b" }, lines)).toEqual([
      { lineId: "l1", variantId: "b", quantity: 2, isAddon: false, sortOrder: 1 },
    ]);
    expect(applyEdit("swap_recipe", { fromVariantId: "x", toVariantId: "b" }, lines)).toBeNull();
  });

  it("applyEdit appends a new addon with a null lineId and the next sort order", () => {
    const lines = [{ lineId: "l1", variantId: "a", quantity: 2, isAddon: false, sortOrder: 1 }];
    expect(applyEdit("add_addon", { variantId: "c", qty: 3 }, lines)).toEqual([
      ...lines,
      { lineId: null, variantId: "c", quantity: 3, isAddon: true, sortOrder: 2 },
    ]);
  });

  it("keeps the subscription error ahead of a faster concurrent line-read failure", async () => {
    const subscription = deferred<{ data: null; error: Error }>();
    const lines = deferred<{ data: null; error: Error }>();
    const from = vi.fn((table: string) => table === "subscriptions"
      ? subscriptionBuilder(subscription.promise)
      : linesBuilder(lines.promise));
    const pending = readSubscriptionAndLines({ from } as unknown as SupabaseClient, "sub-1");

    expect(from).toHaveBeenCalledWith("subscriptions");
    expect(from).toHaveBeenCalledWith("subscription_lines");
    lines.resolve({ data: null, error: new Error("lines_failed") });
    subscription.resolve({ data: null, error: new Error("subscription_failed") });

    await expect(pending).rejects.toThrow("subscription_failed");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function subscriptionBuilder(result: Promise<{ data: null; error: Error }>) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(() => result),
  };
  return builder;
}

function linesBuilder(result: Promise<{ data: null; error: Error }>) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (resolve: (value: { data: null; error: Error }) => unknown) => result.then(resolve),
  };
  return builder;
}
