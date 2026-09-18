import { describe, expect, it } from "vitest";

import {
  applyProviderPaymentEvent as appApplyProviderPaymentEvent,
  canTransitionPaymentAttempt as appCanTransitionPaymentAttempt,
  canTransitionPaymentIntent as appCanTransitionPaymentIntent,
  transitionPaymentAttempt as appTransitionPaymentAttempt,
  transitionPaymentIntent as appTransitionPaymentIntent,
} from "./paymentStateMachine.js";
import {
  applyProviderPaymentEvent as coreApplyProviderPaymentEvent,
  canTransitionPaymentAttempt as coreCanTransitionPaymentAttempt,
  canTransitionPaymentIntent as coreCanTransitionPaymentIntent,
  transitionPaymentAttempt as coreTransitionPaymentAttempt,
  transitionPaymentIntent as coreTransitionPaymentIntent,
} from "@openlup/core/payment";

describe("payment state machine app shim", () => {
  it("re-exports package-owned state transitions", () => {
    expect(appApplyProviderPaymentEvent).toBe(coreApplyProviderPaymentEvent);
    expect(appCanTransitionPaymentAttempt).toBe(coreCanTransitionPaymentAttempt);
    expect(appCanTransitionPaymentIntent).toBe(coreCanTransitionPaymentIntent);
    expect(appTransitionPaymentAttempt).toBe(coreTransitionPaymentAttempt);
    expect(appTransitionPaymentIntent).toBe(coreTransitionPaymentIntent);
  });
});
