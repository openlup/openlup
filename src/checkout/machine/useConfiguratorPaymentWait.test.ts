/** @vitest-environment jsdom -- the controller is a React hook driving state. */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaymentStatusResponse } from "@/domains/commerce/checkoutContracts";

import {
  useConfiguratorPaymentWait,
  type CheckoutInlineWaitStart,
} from "./useConfiguratorPaymentWait";
import type {
  CheckoutPaymentWait,
  CheckoutPaymentWaitOptions,
} from "./useCheckoutPaymentWait";

const { mockUseCheckoutPaymentWait, mockEmitAnalyticsEvent, mockCheckAgain } = vi.hoisted(() => ({
  mockUseCheckoutPaymentWait: vi.fn(),
  mockEmitAnalyticsEvent: vi.fn(),
  mockCheckAgain: vi.fn(),
}));

/**
 * The engine is replaced rather than driven, because the subject here is the
 * controller's own bookkeeping: which ending produces which event, and how many
 * times. Polling, escalation and the cap are the engine's, and already have
 * their own suite.
 */
vi.mock("./useCheckoutPaymentWait", () => ({
  useCheckoutPaymentWait: mockUseCheckoutPaymentWait,
}));

vi.mock("@/lib/analytics/dataLayer", () => ({
  emitAnalyticsEvent: mockEmitAnalyticsEvent,
}));

/** Mutable engine output; a `rerender()` is what applies a change to the hook. */
const engine = {
  options: null as CheckoutPaymentWaitOptions | null,
  waitExhausted: false,
  subscriptionActivation: "not_applicable" as CheckoutPaymentWait["subscriptionActivation"],
};

mockUseCheckoutPaymentWait.mockImplementation(
  (options: CheckoutPaymentWaitOptions): CheckoutPaymentWait => {
    engine.options = options;
    return {
      status: "pending_provider_action",
      subscriptionActivation: engine.subscriptionActivation,
      activationSubscriptionId: null,
      providerPaymentId: "",
      waitExhausted: engine.waitExhausted,
      checkAgain: mockCheckAgain,
    };
  },
);

/**
 * Every field here is exactly the kind of value that must never reach a tag
 * manager, which is the point: the assertions below compare whole payloads, so
 * any of it arriving in one turns this file red.
 */
const START: CheckoutInlineWaitStart = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderRef: "order_11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
  declineMessageKey: "checkout:errors.paymentDeclined",
  // The ONE field here that is allowed to reach a tag manager, and the reason
  // the assertions below check the whole payload rather than just the outcome.
  checkoutMode: "subscription",
};

const SETTLED = {} as PaymentStatusResponse;

function mount() {
  const onPaid = vi.fn();
  const onActivationActionRequired = vi.fn();
  const view = renderHook(() =>
    useConfiguratorPaymentWait({
      draftScope: { kind: "public" },
      onPaid,
      onActivationActionRequired,
    }),
  );
  return { ...view, onPaid, onActivationActionRequired };
}

afterEach(() => {
  mockEmitAnalyticsEvent.mockClear();
  mockCheckAgain.mockClear();
  engine.options = null;
  engine.waitExhausted = false;
  engine.subscriptionActivation = "not_applicable";
});

describe("useConfiguratorPaymentWait funnel events", () => {
  it("announces the wait once, carrying nothing that identifies the order", () => {
    const { result } = mount();

    act(() => result.current.begin(START));

    expect(mockEmitAnalyticsEvent.mock.calls).toEqual([["payment_wait_start", { checkoutMode: "subscription" }]]);
  });

  it("records a settled wait as confirmed", () => {
    const { result } = mount();
    act(() => result.current.begin(START));

    act(() => engine.options?.onPaid(SETTLED));

    expect(mockEmitAnalyticsEvent.mock.calls).toEqual([
      ["payment_wait_start", { checkoutMode: "subscription" }],
      ["payment_wait_end", { outcome: "confirmed", checkoutMode: "subscription" }],
    ]);
  });

  it("records a provider refusal as refused", () => {
    const { result } = mount();
    act(() => result.current.begin(START));

    act(() => engine.options?.onTerminal("failed", "declined", true));

    expect(mockEmitAnalyticsEvent.mock.calls).toEqual([
      ["payment_wait_start", { checkoutMode: "subscription" }],
      ["payment_wait_end", { outcome: "refused", checkoutMode: "subscription" }],
    ]);
  });

  it("hands a terminal refusal identity off once and cannot reseed it after remount", () => {
    const first = mount();
    act(() => first.result.current.begin({ ...START,
      journeyId: "checkout:44444444-4444-4444-8444-444444444444" }));
    act(() => engine.options?.onTerminal("failed", "declined", true));

    expect(first.result.current.recoveryRequest).toEqual({
      orderId: START.orderId,
      paymentIntentId: START.paymentIntentId,
      clientId: START.clientId,
      journeyId: "checkout:44444444-4444-4444-8444-444444444444",
    });
    expect(first.result.current.declineMessageKey).toBe(START.declineMessageKey);

    act(() => first.result.current.consumeRecovery());
    expect(first.result.current.recoveryRequest).toBeNull();
    expect(first.result.current.declineMessageKey).toBeNull();
    first.unmount();

    const second = mount();
    expect(second.result.current.recoveryRequest).toBeNull();
    expect(second.result.current.declineMessageKey).toBeNull();
  });

  it("records the wait cap as no_answer rather than as a failure", () => {
    const { result, rerender } = mount();
    act(() => result.current.begin(START));

    engine.waitExhausted = true;
    act(() => rerender());

    expect(mockEmitAnalyticsEvent.mock.calls).toEqual([
      ["payment_wait_start", { checkoutMode: "subscription" }],
      ["payment_wait_end", { outcome: "no_answer", checkoutMode: "subscription" }],
    ]);
  });

  /**
   * The load-bearing case. A buyer at the cap can ask for a re-read, and that
   * re-read can reach the cap again or settle — three further chances to emit a
   * second outcome for one wait, which would double-count the whole funnel.
   */
  it("emits no second outcome when the buyer's own re-read resolves an exhausted wait", () => {
    const { result, rerender } = mount();
    act(() => result.current.begin(START));
    engine.waitExhausted = true;
    act(() => rerender());

    // The buyer presses "check again": the engine clears the flag and restarts.
    engine.waitExhausted = false;
    act(() => rerender());
    // ...it reaches the cap a second time...
    engine.waitExhausted = true;
    act(() => rerender());
    // ...and only then does the bank answer.
    engine.waitExhausted = false;
    act(() => rerender());
    act(() => engine.options?.onPaid(SETTLED));

    expect(mockEmitAnalyticsEvent.mock.calls).toEqual([
      ["payment_wait_start", { checkoutMode: "subscription" }],
      ["payment_wait_end", { outcome: "no_answer", checkoutMode: "subscription" }],
    ]);
  });

  it("does not report an ending for a wait that never started", () => {
    const { rerender } = mount();

    engine.waitExhausted = true;
    act(() => rerender());

    expect(mockEmitAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("gives a genuinely new attempt its own pair of events", () => {
    const { result } = mount();
    act(() => result.current.begin(START));
    act(() => engine.options?.onTerminal("failed", null, false));

    act(() => result.current.begin(START));
    act(() => engine.options?.onPaid(SETTLED));

    expect(mockEmitAnalyticsEvent.mock.calls).toEqual([
      ["payment_wait_start", { checkoutMode: "subscription" }],
      ["payment_wait_end", { outcome: "refused", checkoutMode: "subscription" }],
      ["payment_wait_start", { checkoutMode: "subscription" }],
      ["payment_wait_end", { outcome: "confirmed", checkoutMode: "subscription" }],
    ]);
  });

  /**
   * A paid order whose recurring mandate still needs the buyer leaves for the
   * standalone status screen. The PAYMENT confirmed there, and the funnel is not
   * asking about the mandate — so it is one `confirmed`, not a fourth member.
   */
  it("counts a hand-back for an unfinished recurring mandate as confirmed, once", () => {
    const { result, rerender, onActivationActionRequired } = mount();
    act(() => result.current.begin(START));

    engine.subscriptionActivation = "action_required";
    act(() => rerender());

    expect(onActivationActionRequired).toHaveBeenCalledTimes(1);
    expect(mockEmitAnalyticsEvent.mock.calls).toEqual([
      ["payment_wait_start", { checkoutMode: "subscription" }],
      ["payment_wait_end", { outcome: "confirmed", checkoutMode: "subscription" }],
    ]);
  });

  it("does not turn a refused analytics admission into a business retry", () => {
    mockEmitAnalyticsEvent.mockReturnValue({ deployment: false, optional: false });
    const { result } = mount();

    act(() => result.current.begin(START));
    act(() => engine.options?.onPaid(SETTLED));

    expect(mockEmitAnalyticsEvent).toHaveBeenCalledTimes(2);
  });
});
