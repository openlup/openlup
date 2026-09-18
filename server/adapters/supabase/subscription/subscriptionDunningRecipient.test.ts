import { describe, expect, it } from "vitest";
import { createSupabaseSubscriptionDunningRecipientPort } from "./subscriptionDunningRecipient.js";

const signal = new AbortController().signal;

function clientReturning(result: { data: unknown; error: { message?: string } | null }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
  };
  return { from: () => builder } as never;
}

describe("createSupabaseSubscriptionDunningRecipientPort", () => {
  it("resolves a recipient from the clients row", async () => {
    const port = createSupabaseSubscriptionDunningRecipientPort(
      clientReturning({ data: { email: "a@b.pl", first_name: "Ada", country: "PL" }, error: null }),
    );
    expect(await port.resolve("c1", signal)).toEqual({
      email: "a@b.pl",
      firstName: "Ada",
      country: "PL",
    });
  });

  it("throws with the dunning_recipient_read_failed prefix on error", async () => {
    const port = createSupabaseSubscriptionDunningRecipientPort(
      clientReturning({ data: null, error: { message: "boom" } }),
    );
    await expect(port.resolve("c1", signal)).rejects.toThrow("dunning_recipient_read_failed: boom");
  });
});
