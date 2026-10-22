import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FULFILLMENT_STATUS_MAP, CANONICAL_LOCAL_FULFILLMENT_STATUSES, CUSTOMER_STEP_SEQUENCE, canonicalStatusToken, customerStepFromSignals, phaseIndexForStep, stepForToken, stepLabelKey, timelineLabelForStep, trackingPhaseKeyForStep, stepUsesTruckIcon } from "../../src/fulfillment/index.js";

describe("contributed status canon (W1)", () => {
  it("preserves the donor canonical projection bytes after removing private trace columns", () => {
    const projection = FULFILLMENT_STATUS_MAP.stages.map(({ customerStep, rank, phaseIndex, onTrack, localStatus, omsFulfillmentStatus, orderStatus, aliasTokens, effects }) => ({ customerStep, rank, phaseIndex, onTrack, localStatus, omsFulfillmentStatus, orderStatus, aliasTokens, effects }));
    expect(createHash("sha256").update(JSON.stringify(projection)).digest("hex")).toBe("93ec11a68d386d2a742a2925154482766cd30380382b5836903b8039fe602023");
    expect(CANONICAL_LOCAL_FULFILLMENT_STATUSES).toEqual(["provider_received", "picking", "packed", "in_transit", "delivered", "exception", "cancelled"]);
  });
  it("resolves every donor token and retains conservative fallback and rank decisions", () => {
    for (const stage of FULFILLMENT_STATUS_MAP.stages) {
      for (const token of [...stage.localStatus, ...stage.omsFulfillmentStatus, ...stage.orderStatus, ...stage.aliasTokens]) expect(stepForToken(token)).toBe(stage.customerStep);
    }
    expect(canonicalStatusToken("  Label-Created  ")).toBe("label_created");
    expect(stepForToken("future_unknown")).toBeNull();
    expect(stepForToken("future_deliver_event")).toBe("delivered"); // display fallback only, never arrival evidence
    expect(customerStepFromSignals(["label_created", "picking"])).toBe("packing");
    expect(customerStepFromSignals(["returned_to_sender", "delivered"])).toBe("delivered");
    expect(customerStepFromSignals([null, undefined, "unknown"])).toBe("paid");
  });
  it("keeps off-track phases and host label bytes separate from arrival proof", () => {
    expect(CUSTOMER_STEP_SEQUENCE).toEqual(["paid", "accepted", "packing", "transit", "delivered"]);
    for (const stage of FULFILLMENT_STATUS_MAP.stages) {
      expect(phaseIndexForStep(stage.customerStep)).toBe(stage.phaseIndex);
      expect(stepLabelKey(stage.customerStep)).toBe(stage.stepLabelKey);
      expect(timelineLabelForStep(stage.customerStep)).toBe(stage.timelineLabel);
      expect(trackingPhaseKeyForStep(stage.customerStep)).toBe(stage.trackingPhaseKey);
      expect(stepUsesTruckIcon(stage.customerStep)).toBe(["transit", "delivered"].includes(stage.customerStep));
    }
    expect(phaseIndexForStep("exception")).toBe(1);
    expect(phaseIndexForStep("cancelled")).toBe(0);
  });
});
