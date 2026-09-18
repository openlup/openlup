import { describe, expect, it } from "vitest";
import { makePickupIdempotencyKey } from "./courierPickupStore.js";

describe("pickup persistence contract", () => {
  it("builds the same key for the same selected set regardless of input order", () => {
    const first = makePickupIdempotencyKey(
      ["tester-b", "tester-a"],
      "2026-08-17",
      "10:00",
      "12:00",
    );
    const second = makePickupIdempotencyKey(
      ["tester-a", "tester-b"],
      "2026-08-17",
      "10:00",
      "12:00",
    );

    expect(first).toBe(second);
    expect(first).toContain("tester-a,tester-b");
  });

  it("keeps different pickup windows in separate idempotency scopes", () => {
    const morning = makePickupIdempotencyKey(
      ["tester-a"],
      "2026-08-17",
      "10:00",
      "12:00",
    );
    const afternoon = makePickupIdempotencyKey(
      ["tester-a"],
      "2026-08-17",
      "12:00",
      "14:00",
    );

    expect(morning).not.toBe(afternoon);
  });
});
