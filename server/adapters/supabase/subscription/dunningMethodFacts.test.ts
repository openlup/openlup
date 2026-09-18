import { describe, expect, it, vi } from "vitest";
import {
  methodFactsFromConsentSnapshot,
} from "../../../domains/subscription/subscriptionDunningDispatchPorts.js";
import {
  createDunningMethodFactsPort,
  type DunningMethodFactsQueryClient,
} from "./dunningMethodFacts.js";

const SIGNAL = new AbortController().signal;

function clientFor(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      calls.push([column, value]);
      return builder;
    }),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
  };
  const from = vi.fn(() => builder);
  return { client: { from } as unknown as DunningMethodFactsQueryClient, from, builder, calls };
}

describe("methodFactsFromConsentSnapshot", () => {
  it("reads the two snapshot keys the card rail writes", () => {
    expect(
      methodFactsFromConsentSnapshot({
        recurringModel: "O",
        methodScheme: "visa",
        methodLastDigits: "4242",
      }),
    ).toEqual({ scheme: "visa", lastDigits: "4242" });
  });

  it("returns null when the snapshot carries neither fact", () => {
    expect(methodFactsFromConsentSnapshot({ recurringModel: "O" })).toBeNull();
    expect(methodFactsFromConsentSnapshot(null)).toBeNull();
    expect(methodFactsFromConsentSnapshot("visa")).toBeNull();
    expect(methodFactsFromConsentSnapshot([])).toBeNull();
  });

  it("keeps one half when only one is stored, so the copy can still drop it", () => {
    expect(methodFactsFromConsentSnapshot({ methodLastDigits: "4242" }))
      .toEqual({ scheme: null, lastDigits: "4242" });
    expect(methodFactsFromConsentSnapshot({ methodScheme: "amex" }))
      .toEqual({ scheme: "amex", lastDigits: null });
  });

  // The digits reach a customer-visible email. Anything that is not a short
  // digit run is a snapshot this rail does not understand, and printing it
  // would be worse than printing nothing.
  it("drops digits that are not a short digit run", () => {
    for (const bad of ["4242424242424242", "42", "abcd", "", "  ", "12 34", "4-42"]) {
      const facts = methodFactsFromConsentSnapshot({ methodScheme: "visa", methodLastDigits: bad });
      expect(facts?.lastDigits ?? null).toBe(bad === "42" ? "42" : null);
    }
  });

  it("drops an implausibly long scheme token", () => {
    const facts = methodFactsFromConsentSnapshot({
      methodScheme: "x".repeat(40),
      methodLastDigits: "4242",
    });
    expect(facts).toEqual({ scheme: null, lastDigits: "4242" });
  });
});

describe("createDunningMethodFactsPort", () => {
  it("reads the active ref for the subscription and maps its snapshot", async () => {
    const { client, from, calls } = clientFor({
      data: { consent_snapshot: { methodScheme: "visa", methodLastDigits: "4242" } },
      error: null,
    });
    const port = createDunningMethodFactsPort(client);

    await expect(port.resolve("sub-1", SIGNAL)).resolves.toEqual({
      scheme: "visa",
      lastDigits: "4242",
    });
    expect(from).toHaveBeenCalledWith("commerce_payment_method_refs");
    expect(calls).toEqual([
      ["subscription_id", "sub-1"],
      ["active", true],
    ]);
  });

  it("answers null on a read error instead of throwing at the dispatcher", async () => {
    const { client } = clientFor({ data: null, error: { message: "boom" } });
    const port = createDunningMethodFactsPort(client);
    await expect(port.resolve("sub-1", SIGNAL)).resolves.toBeNull();
  });

  it("answers null when the subscription has no active ref", async () => {
    const { client } = clientFor({ data: null, error: null });
    const port = createDunningMethodFactsPort(client);
    await expect(port.resolve("sub-1", SIGNAL)).resolves.toBeNull();
  });

  it("does not query at all without a subscription id", async () => {
    const { client, from } = clientFor({ data: null, error: null });
    const port = createDunningMethodFactsPort(client);
    await expect(port.resolve("", SIGNAL)).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
