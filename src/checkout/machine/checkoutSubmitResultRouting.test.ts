import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutResponse } from "@/domains/commerce/checkoutContracts";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import { PUBLIC_CONFIGURATOR_DRAFT_SCOPE } from "@/checkout/composer/configuratorDraftStore";
import { PSP_PROVIDER_KINDS } from "@/domains/payment/pspIntegrationPlan";
import { readCheckoutContinuation } from "./checkoutNavigation";
import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "@/domains/commerce/paymentContinuationContracts";
import { routeConfiguratorCheckoutResult } from "./checkoutSubmitResultRouting";
import type { CheckoutInlineWaitStart } from "./useConfiguratorPaymentWait";

const JOURNEY_ID = "checkout:66666666-6666-4666-8666-666666666666";

/** Frozen so the marker's stamped `expiresAt` is an exact expectation below. */
const NOW_MS = 1_760_000_000_000;
const EXPECTED_EXPIRES_AT = Math.floor(NOW_MS / 1000) + CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS;

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("checkout result continuation routing", () => {
  it("persists only public exact-attempt hints from a fresh embedded action response", () => {
    const setEmbedded = vi.fn();
    routeConfiguratorCheckoutResult({
      ...routingDeps("embedded", setEmbedded),
      result: embeddedResponse(),
      source: "submit",
      journeyId: JOURNEY_ID,
    });

    expect(readCheckoutContinuation()).toEqual({
      orderId: "11111111-1111-4111-8111-111111111111",
      orderRef: "order_11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      journeyId: JOURNEY_ID,
      actionKind: "embedded",
      // A marker is born on the server issuing the action, not on a commit: the
      // buyer has not pressed Pay, so nothing may be waited on yet.
      phase: "action_issued",
      expiresAt: EXPECTED_EXPIRES_AT,
    });
    expect(JSON.stringify(readCheckoutContinuation())).not.toContain("pi_secret");
    expect(setEmbedded).toHaveBeenCalledWith(expect.objectContaining({
      journeyId: JOURNEY_ID,
      clientSecret: "pi_secret",
    }));
  });

  it("does not create continuation hints from ambiguous readback", () => {
    const navigate = vi.fn();
    const setEmbedded = vi.fn();
    routeConfiguratorCheckoutResult({
      ...routingDeps("embedded", setEmbedded),
      navigate,
      result: embeddedResponse(),
      source: "ambiguous_readback",
      journeyId: JOURNEY_ID,
    });

    expect(readCheckoutContinuation()).toBeNull();
    expect(setEmbedded).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
  });

  it("persists the exact continuation before following its fresh redirect", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });

    routeConfiguratorCheckoutResult({
      ...routingDeps("redirect"),
      result: redirectResponse(),
      source: "submit",
      journeyId: JOURNEY_ID,
    });

    expect(readCheckoutContinuation()).toEqual({
      orderId: "11111111-1111-4111-8111-111111111111",
      orderRef: "order_11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      journeyId: JOURNEY_ID,
      actionKind: "redirect",
      phase: "action_issued",
      expiresAt: EXPECTED_EXPIRES_AT,
    });
    expect(assign).toHaveBeenCalledWith("https://payments.example/continue");
  });
});

describe("checkout result continuation routing (readback precedence)", () => {
  it("still routes an actionless ambiguous replay to the poller", () => {
    // Survives the gate removal untouched: with no action to reopen, an
    // ambiguous replay has only the poller to settle it. Kept here rather than
    // deleted with its former resume-OFF siblings, because it pins the readback
    // branch itself, not the gate that used to select it.
    const navigate = vi.fn();
    const setEmbedded = vi.fn();
    routeConfiguratorCheckoutResult({
      ...routingDeps("embedded", setEmbedded),
      navigate,
      result: actionlessResponse(),
      source: "ambiguous_readback",
      journeyId: JOURNEY_ID,
    });

    expect(setEmbedded).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
  });
});

describe("checkout result routing for a RESUMED order", () => {
  it("routes a resumed order to the status page on the embedded rail", () => {
    // The server recognised an attempt already in flight for this buyer and
    // answered with it instead of opening a second one, so it carries
    // `clientAction: {kind:"none"}` and there is nothing to drive. The redirect
    // rail always routed this correctly; the embedded rail fell through to the
    // missing-payment-intent throw below and told the buyer their order could
    // not be placed — for an order that very much was.
    const navigate = vi.fn();
    const setEmbedded = vi.fn();

    routeConfiguratorCheckoutResult({
      ...routingDeps("embedded", setEmbedded),
      navigate,
      result: resumedResponse(),
      source: "submit",
      journeyId: JOURNEY_ID,
    });

    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
    expect(setEmbedded).not.toHaveBeenCalled();
    // A resumed order is not a fresh action, so nothing is persisted for it.
    expect(readCheckoutContinuation()).toBeNull();
  });

  it("still throws when an embedded response carries no action AND no status to poll", () => {
    // The throw is not removed, only stopped from swallowing resumes. A response
    // that is neither actionful nor pollable is a real contract violation and
    // must stay loud.
    expect(() => routeConfiguratorCheckoutResult({
      ...routingDeps("embedded"),
      result: resumedWithStatus("unknown"),
      source: "submit",
      journeyId: JOURNEY_ID,
    })).toThrow("stripe_checkout_missing_payment_intent");
  });

  it("leaves a terminal actionless response to the decline path, not the poller", () => {
    // A declined checkout arrives with the SAME actionless shape. Keying the
    // resume branch on a non-terminal status is what keeps the two apart, so an
    // inline decline is never routed to a poller that has nothing to settle.
    //
    // Asserts what THIS branch owns — that the resume branch does not claim it —
    // and deliberately NOT which error comes back. A parallel wave adds a
    // `status === "failed"` branch above this file's readback return that will
    // answer this case with an inline decline instead of the missing-intent
    // throw. Pinning the error identity here would encode the pre-merge
    // fallthrough and break the moment that lands; not navigating is the
    // invariant that holds either way.
    const navigate = vi.fn();
    const setEmbedded = vi.fn();

    expect(() => routeConfiguratorCheckoutResult({
      ...routingDeps("embedded", setEmbedded),
      navigate,
      result: resumedWithStatus("failed"),
      source: "submit",
      journeyId: JOURNEY_ID,
    })).toThrow();
    expect(navigate).not.toHaveBeenCalled();
    expect(setEmbedded).not.toHaveBeenCalled();
  });
});

describe("an actionless BLIK submit leaves a continuation marker behind", () => {
  it("writes the marker for a fresh BLIK submit, dispatched and actionless", () => {
    // BLIK Level 0 has no client action: the buyer typed a code on this page,
    // the provider call went out, and all that is left is the push in their
    // banking app. Money CAN be in flight, so a refresh mid-wait must be able
    // to resume — which is what this marker, and only this marker, makes
    // possible once the URL query string stops being the resume story.
    const navigate = vi.fn();

    routeConfiguratorCheckoutResult({
      ...routingDeps("redirect"),
      navigate,
      result: blikSubmitResponse(),
      source: "submit",
      journeyId: JOURNEY_ID,
    });

    expect(readCheckoutContinuation()).toEqual({
      orderId: "11111111-1111-4111-8111-111111111111",
      orderRef: "order_11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      journeyId: JOURNEY_ID,
      actionKind: "none",
      // NOT `action_issued`. The buyer has already handed over a credential, so
      // claiming the provider was never called would be a lie the resume guard
      // acts on: it discards `action_issued` markers, which here would abandon
      // a charge that may already be settling.
      phase: "confirm_dispatched",
      expiresAt: EXPECTED_EXPIRES_AT,
    });
  });

  it("still navigates to the status page when no host can hold the wait", () => {
    // The marker is not a redirect, and the status page is still the answer for
    // every caller that cannot keep the buyer where they are: a redirect rail, a
    // refresh, a cold link from an e-mail, and the account shell.
    const navigate = vi.fn();

    routeConfiguratorCheckoutResult({
      ...routingDeps("redirect"),
      navigate,
      result: blikSubmitResponse(),
      source: "submit",
      journeyId: JOURNEY_ID,
    });

    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
  });

  it("writes NOTHING for a resumed order wearing the same actionless shape", () => {
    // The discriminator under test. A resumed order carries `clientAction:
    // {kind:"none"}` too, so keying on the action shape alone would mint a
    // marker claiming THIS request dispatched a payment it never dispatched.
    // Only the orchestrated fresh checkout re-prices and returns
    // `authoritativeQuote`; the resume guard answers with an order it merely
    // recognised.
    const navigate = vi.fn();

    routeConfiguratorCheckoutResult({
      ...routingDeps("redirect"),
      navigate,
      result: resumedResponse(),
      source: "submit",
      journeyId: JOURNEY_ID,
    });

    expect(readCheckoutContinuation()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
  });

  it("writes NOTHING for an ambiguous readback of the same shape", () => {
    // A readback reports on an attempt the server has already moved past. It
    // is not a commit this browser made, so it may not leave a marker asserting
    // one — even when the payload it replays is a fresh submit's, quote and all.
    const navigate = vi.fn();

    routeConfiguratorCheckoutResult({
      ...routingDeps("redirect"),
      navigate,
      result: blikSubmitResponse(),
      source: "ambiguous_readback",
      journeyId: JOURNEY_ID,
    });

    expect(readCheckoutContinuation()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
  });
});

/**
 * A fresh BLIK Level 0 submit: pollable, actionless, and carrying the
 * `authoritativeQuote` that only the orchestrated checkout returns.
 *
 * The quote is cast rather than built in full because nothing here reads inside
 * it — its PRESENCE is the whole signal, and spelling out a complete priced
 * basket would suggest the router cares what is in one.
 */
function blikSubmitResponse(): CheckoutResponse {
  return {
    ...resumedResponse(),
    status: "pending_provider_action",
    providerPaymentId: "psp_tx_9001",
    authoritativeQuote: { contractVersion: "commerce.v2", quote: {} },
  } as unknown as CheckoutResponse;
}

/** What the server's duplicate-charge guard answers with: an in-flight order. */
function resumedResponse(): CheckoutResponse {
  return {
    contractVersion: "commerce.checkout.v2",
    checkoutKind: "one_time",
    status: "processing",
    orderId: "11111111-1111-4111-8111-111111111111",
    orderRef: "order_11111111-1111-4111-8111-111111111111",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333",
    clientAction: { kind: "none" },
  };
}

/**
 * The same actionless shape carrying a status the resume branch must NOT claim.
 * Cast on purpose: these are responses the contract does not model as resumable,
 * and the point of the cases below is what the router does when one arrives.
 */
function resumedWithStatus(status: string): CheckoutResponse {
  return { ...resumedResponse(), status } as unknown as CheckoutResponse;
}

function embeddedResponse(): CheckoutResponse {
  return {
    contractVersion: "commerce.checkout.v2",
    checkoutKind: "one_time",
    status: "processing",
    orderId: "11111111-1111-4111-8111-111111111111",
    orderRef: "order_11111111-1111-4111-8111-111111111111",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333",
    clientAction: {
      kind: "provider_embedded",
      provider: PSP_PROVIDER_KINDS[0],
      clientSecret: "pi_secret",
    },
  };
}

function actionlessResponse(): CheckoutResponse {
  return {
    contractVersion: "commerce.checkout.v2",
    checkoutKind: "one_time",
    status: "processing",
    orderId: "11111111-1111-4111-8111-111111111111",
    orderRef: "order_11111111-1111-4111-8111-111111111111",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333",
  };
}

function redirectResponse(): CheckoutResponse {
  return {
    contractVersion: "commerce.checkout.v2",
    checkoutKind: "one_time",
    status: "processing",
    orderId: "11111111-1111-4111-8111-111111111111",
    orderRef: "order_11111111-1111-4111-8111-111111111111",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333",
    clientAction: {
      kind: "redirect",
      url: "https://payments.example/continue",
    },
  };
}

function routingDeps(
  actionKind: "embedded" | "redirect",
  setEmbedded = vi.fn(),
  onInlineWait?: (start: CheckoutInlineWaitStart) => void,
) {
  return {
    data: {} as ConfiguratorFormData,
    ...(onInlineWait ? { onInlineWait } : {}),
    navigate: vi.fn(),
    paths: { thankYou: "/thanks", paymentPath: "/payment" },
    accountMode: false,
    hasTpayPatch: actionKind === "redirect",
    useStripe: actionKind === "embedded",
    draftScope: PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
    setStripePay: setEmbedded,
  };
}

/**
 * A refused provider attempt is a retry, not a destination. The server reports
 * it as `status: "failed"` — an existing member of `ASYNC_CHECKOUT_STATUSES`, so
 * no contract widened — and the step keeps the buyer. Deliberately written
 * WITHOUT touching the resume flag: this behaviour must be identical in both
 * lanes and must survive the flag being removed entirely.
 */
describe("a refused attempt stays on the payment step", () => {
  function declineResponse(): CheckoutResponse {
    return {
      ...(embeddedResponse() as Record<string, unknown>),
      status: "failed",
      clientAction: { kind: "none" },
    } as unknown as CheckoutResponse;
  }

  function routeDecline(paymentMethod: string | null) {
    const deps = routingDeps("embedded");
    let thrown: unknown;
    try {
      routeConfiguratorCheckoutResult({
        ...deps,
        data: { paymentMethod } as unknown as ConfiguratorFormData,
        result: declineResponse(),
        source: "submit",
        journeyId: JOURNEY_ID,
      });
    } catch (error) {
      thrown = error;
    }
    return { thrown, navigate: deps.navigate, mountPanel: deps.setStripePay };
  }

  it("never navigates and never mounts a payment panel", () => {
    const { thrown, navigate, mountPanel } = routeDecline("blik");

    expect(thrown).toBeInstanceOf(Error);
    expect(navigate).not.toHaveBeenCalled();
    expect(mountPanel).not.toHaveBeenCalled();
  });

  it("tells the buyer what to do about the method they actually picked", () => {
    expect((routeDecline("blik").thrown as Error).message)
      .toBe("checkout:errors.paymentDeclinedBlik");
    expect((routeDecline("blik_one_click").thrown as Error).message)
      .toBe("checkout:errors.paymentDeclinedBlik");
    expect((routeDecline("card").thrown as Error).message)
      .toBe("checkout:errors.paymentDeclinedCard");
    // An unknown or unset method must still produce an actionable sentence.
    expect((routeDecline(null).thrown as Error).message)
      .toBe("checkout:errors.paymentDeclinedRecoverable");
  });

});

/**
 * The handoff that lets the buyer stay where they are. It is offered ONLY for a
 * fresh dispatch on a rail confirmed inside the banking application, and only to
 * a host that asked for it — every other combination keeps the status page,
 * which is what makes this wave BLIK-only rather than a routing rewrite.
 */
describe("a dispatched code-entry submit is handed to its host, not to a URL", () => {
  function routeWith(paymentMethod: string | null, result: CheckoutResponse) {
    const onInlineWait = vi.fn();
    const deps = routingDeps("redirect", vi.fn(), onInlineWait);
    routeConfiguratorCheckoutResult({
      ...deps,
      data: { paymentMethod } as unknown as ConfiguratorFormData,
      result,
      source: "submit",
      journeyId: JOURNEY_ID,
    });
    return { onInlineWait, navigate: deps.navigate };
  }

  it("hands over the identity and the decline sentence, and does not navigate", () => {
    const { onInlineWait, navigate } = routeWith("blik", blikSubmitResponse());

    expect(navigate).not.toHaveBeenCalled();
    expect(onInlineWait).toHaveBeenCalledWith({
      journeyId: "checkout:66666666-6666-4666-8666-666666666666",
      orderId: "11111111-1111-4111-8111-111111111111",
      orderRef: "order_11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      // Chosen HERE, at the submit, from the method actually charged — so the
      // wait replays a sentence rather than guessing one later.
      declineMessageKey: "checkout:errors.paymentDeclinedBlik",
      // Read at the submit too, so the wait can be measured beside the rest of
      // the funnel instead of collapsing one-time and recurring into one number.
      checkoutMode: "one_time",
    });
  });

  it("carries the recurring mode, which is the segmentation this product turns on", () => {
    const onInlineWait = vi.fn();
    const deps = routingDeps("redirect", vi.fn(), onInlineWait);
    routeConfiguratorCheckoutResult({
      ...deps,
      data: { paymentMethod: "blik", subscription: { intervalDays: 28 } } as unknown as ConfiguratorFormData,
      result: blikSubmitResponse(),
      source: "submit",
      journeyId: JOURNEY_ID,
    });

    expect(onInlineWait).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutMode: "subscription" }),
    );
  });

  it("hands over the saved-alias variant too — same app, same push, same story", () => {
    const { onInlineWait, navigate } = routeWith("blik_one_click", blikSubmitResponse());

    expect(navigate).not.toHaveBeenCalled();
    expect(onInlineWait).toHaveBeenCalledTimes(1);
  });

  it("leaves a RESUMED order on the status page even with a host present", () => {
    // No `authoritativeQuote`: this request dispatched nothing, so there is no
    // wait of ours to hold. Holding it would tell the buyer we had just asked
    // their bank something when we had not.
    const { onInlineWait, navigate } = routeWith("blik", resumedResponse());

    expect(onInlineWait).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
  });

  it("leaves a method the host does not own on the status page", () => {
    const { onInlineWait, navigate } = routeWith("transfer", blikSubmitResponse());

    expect(onInlineWait).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/payment"));
  });
});
