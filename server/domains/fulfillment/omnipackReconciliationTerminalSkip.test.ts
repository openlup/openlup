import { describe, expect, it } from "vitest";
import {
  OFF_TRACK_FULFILLMENT_STATUSES,
  isOffTrackFulfillmentStatus,
} from "./omnipackReconciliationTerminalSkip.js";

describe("OmniPack reconciliation off-track fulfillment states", () => {
  // These are exactly the fulfillment statuses that
  // omnipack_acknowledge_dispatch_acceptance rejects with
  // omnipack_dispatch_label_ack_invalid_fulfillment_status (22023): the RPC
  // accepts created|label_pending|label_created|packed|handed_over|in_transit|
  // delivered, and the FSM CHECK allows exactly those plus exception+cancelled.
  // If this drifts, the reconciliation job goes red on every run again.
  it("derives exactly the two statuses the acceptance ack cannot converge", () => {
    expect([...OFF_TRACK_FULFILLMENT_STATUSES].sort()).toEqual(["cancelled", "exception"]);
  });

  it.each(["cancelled", "exception"])("treats %s as off-track", (status) => {
    expect(isOffTrackFulfillmentStatus(status)).toBe(true);
  });

  it.each([
    "created",
    "label_pending",
    "label_created",
    "packed",
    "handed_over",
    "in_transit",
    "delivered",
  ])("treats the ack-able status %s as on-track", (status) => {
    expect(isOffTrackFulfillmentStatus(status)).toBe(false);
  });

  // An unrecognised or missing status must NOT be silently skipped — that would
  // hide a real state behind a benign disposition. Reconciliation proceeds and
  // fails loudly instead.
  it.each([null, undefined, "", "some_future_status"])(
    "does not skip unknown status %s",
    (status) => {
      expect(isOffTrackFulfillmentStatus(status)).toBe(false);
    },
  );
});
