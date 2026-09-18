import { describe, expect, it } from "vitest";
import { OUTBOX_REVIEW_REQUEST_TEMPLATE_SLUG } from "./marketingEmailPorts.js";

// Companion test for the marketing email ports module (mostly type-only port
// contracts + one runtime const). Pins the review-request dedupe slug so a
// rename can't silently break the ledger dedupe.
describe("marketingEmailPorts", () => {
  it("exposes the review-request template slug", () => {
    expect(OUTBOX_REVIEW_REQUEST_TEMPLATE_SLUG).toBe("commerce-order-review-request");
  });
});
