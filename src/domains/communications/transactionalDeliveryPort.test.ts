import { describe, expect, it } from "vitest";

import { isTransactionalDeliveryIdentifier } from "./transactionalDeliveryPort.js";

describe("transactional delivery port identifiers", () => {
  it.each([
    "delivery-1",
    "attempt:42.template_2",
    "A",
    "a".repeat(256),
  ])("accepts bounded opaque identifier %s", (value) => {
    expect(isTransactionalDeliveryIdentifier(value)).toBe(true);
  });

  it.each([
    "",
    " leading-space",
    "recipient@example.invalid",
    "raw exception: details",
    "a".repeat(257),
  ])("rejects non-neutral identifier %s", (value) => {
    expect(isTransactionalDeliveryIdentifier(value)).toBe(false);
  });
});
