import { describe, expect, it, vi } from "vitest";
import { PAYMENT_EXECUTION_PROVIDERS } from "../../../src/domains/payment/types.js";

import {
  CHECKOUT_PAYMENT_CONTINUATION_COOKIE,
  createCheckoutPaymentContinuationCodec,
  mintPaymentContinuationOnFreshAction,
} from "./checkoutPaymentContinuationCredential.js";
import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "../../../src/domains/commerce/paymentContinuationContracts.js";

const EMBEDDED_RAIL = PAYMENT_EXECUTION_PROVIDERS[2];
const REDIRECT_RAIL = PAYMENT_EXECUTION_PROVIDERS[3];

const INPUT = {
  journeyId: "checkout:11111111-1111-4111-8111-111111111111",
  orderId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
  paymentIntentId: "44444444-4444-4444-8444-444444444444",
  paymentAttemptId: "55555555-5555-4555-8555-555555555555",
  executionRail: EMBEDDED_RAIL,
};

describe("checkout payment continuation credential", () => {
  it("issues an attempt-bound HttpOnly host cookie without provider action data", () => {
    const codec = createCheckoutPaymentContinuationCodec("s".repeat(32), {
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });
    const issued = codec?.issue(INPUT);

    expect(issued?.setCookie).toContain(`${CHECKOUT_PAYMENT_CONTINUATION_COOKIE}=`);
    // `Max-Age` follows the shared TTL, so the cookie and the browser's own
    // marker cannot expire at different moments.
    expect(issued?.setCookie).toContain("Path=/; Max-Age=2700; Secure; HttpOnly; SameSite=Strict");
    expect(issued?.setCookie).not.toContain("Domain=");
    expect(issued?.setCookie).not.toContain("client_secret");
    expect(issued?.setCookie).not.toContain("https://");
    expect(codec?.verifyCookieHeader(`other=x; ${issued?.setCookie.split(";")[0]}`)).toEqual(issued?.claims);
  });

  it("rejects missing, short, tampered, differently signed, and expired credentials", () => {
    expect(createCheckoutPaymentContinuationCodec(undefined)).toBeNull();
    expect(createCheckoutPaymentContinuationCodec("short")).toBeNull();
    const now = new Date("2026-08-20T12:00:00.000Z");
    const codec = createCheckoutPaymentContinuationCodec("a".repeat(32), { now: () => now });
    const issued = codec?.issue(INPUT).setCookie.split(";")[0] ?? "";
    expect(codec?.verifyCookieHeader(`${issued}x`)).toBeNull();
    expect(createCheckoutPaymentContinuationCodec("b".repeat(32), { now: () => now })?.verifyCookieHeader(issued)).toBeNull();
    // One minute past the TTL, derived rather than hardcoded: this leg proves
    // "expired is rejected", and a literal 16 silently stopped proving that the
    // moment the TTL moved past 16 minutes.
    now.setSeconds(now.getSeconds() + CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS + 60);
    expect(codec?.verifyCookieHeader(issued)).toBeNull();
  });

  it("validates input and configured TTL bounds", () => {
    const codec = createCheckoutPaymentContinuationCodec("s".repeat(32));
    expect(() => codec?.issue({ ...INPUT, journeyId: "copied" })).toThrow(/Invalid/);
    expect(() => createCheckoutPaymentContinuationCodec("s".repeat(32), { ttlSeconds: 59 })).toThrow(/TTL/);
    expect(() => createCheckoutPaymentContinuationCodec("s".repeat(32), {
      ttlSeconds: CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS + 1,
    })).toThrow(/TTL/);
  });

  it.each([
    [EMBEDDED_RAIL, { status: "started", clientAction: { kind: "provider_embedded", provider: EMBEDDED_RAIL, clientSecret: "secret" } }],
    [REDIRECT_RAIL, { status: "started", clientAction: { kind: "redirect", url: "https://payments.example/pay" } }],
  ] as const)("mints only the fresh action for the exact %s rail", (executionRail, response) => {
    const mint = vi.fn();
    mintPaymentContinuationOnFreshAction({
      mint,
      res: {} as Parameters<typeof mintPaymentContinuationOnFreshAction>[0]["res"],
      journeyId: INPUT.journeyId,
      clientId: INPUT.clientId,
      requestRail: executionRail,
      response,
      result: {
        continuationActionOrigin: "fresh_execution",
        executionRail,
        paymentAttemptId: INPUT.paymentAttemptId,
        paymentIntentId: INPUT.paymentIntentId,
        orderId: INPUT.orderId,
      },
    });

    expect(mint).toHaveBeenCalledWith(expect.anything(), {
      ...INPUT,
      executionRail,
    });
  });

  /**
   * The buyer is inside their banking application and the browser was handed no
   * action, because a code-entry rail has none to give. The wait panel that shows
   * this state also offers the way out of an embedded webview, and the cookie is
   * that control's only authority — so refusing to mint here is what made the
   * escape hatch inert on the rail it was built for.
   */
  it("mints for a dispatched code-entry attempt, which carries no action to hand back", () => {
    const mint = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mintPaymentContinuationOnFreshAction({
      mint,
      res: {} as Parameters<typeof mintPaymentContinuationOnFreshAction>[0]["res"],
      journeyId: INPUT.journeyId,
      clientId: INPUT.clientId,
      requestRail: REDIRECT_RAIL,
      response: { status: "processing", clientAction: { kind: "none" } },
      result: {
        continuationActionOrigin: "fresh_execution",
        executionRail: REDIRECT_RAIL,
        paymentAttemptId: INPUT.paymentAttemptId,
        paymentIntentId: INPUT.paymentIntentId,
        orderId: INPUT.orderId,
      },
    });

    expect(mint).toHaveBeenCalledWith(expect.anything(), { ...INPUT, executionRail: REDIRECT_RAIL });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(["replay", "missing_attempt", "wrong_rail", "settled_paid", "settled_failed"] as const)(
    "does not mint on replay, mismatch, or an action-free response that already SETTLED: %s",
    (condition) => {
    const mint = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mintPaymentContinuationOnFreshAction({
      mint,
      res: {} as Parameters<typeof mintPaymentContinuationOnFreshAction>[0]["res"],
      journeyId: INPUT.journeyId,
      clientId: INPUT.clientId,
      requestRail: condition === "wrong_rail" ? REDIRECT_RAIL : EMBEDDED_RAIL,
      // A terminal status is the OTHER thing an absent action means, and the only
      // discriminator between the two: `checkoutClientAction` emits `none` for a
      // settled attempt exactly as it does for a dispatched code entry. Minting
      // for these would mail a buyer a way to finish an order that is finished.
      response: condition === "settled_paid" || condition === "settled_failed"
        ? { status: condition === "settled_paid" ? "paid" : "failed", clientAction: { kind: "none" } }
        : { status: "processing", clientAction: { kind: "provider_embedded", provider: EMBEDDED_RAIL, clientSecret: "secret" } },
      result: {
        continuationActionOrigin: condition === "replay" ? null : "fresh_execution" as "fresh_execution" | null,
        executionRail: EMBEDDED_RAIL,
        paymentAttemptId: condition === "missing_attempt" ? null : INPUT.paymentAttemptId,
        paymentIntentId: INPUT.paymentIntentId,
        orderId: INPUT.orderId,
      },
    });
    expect(mint).not.toHaveBeenCalled();
    // None of these is an operator problem: the attempt simply does not want a
    // continuation. Staying quiet here is what keeps the one warning below
    // meaningful.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when a fresh action wanted a continuation and no minter exists", () => {
    // The whole reason this capability could sit dormant in every environment
    // without anyone noticing. An absent signing secret is invisible in the
    // response — checkout still succeeds and the card form still opens — so the
    // log line is the only place it surfaces.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mintPaymentContinuationOnFreshAction({
      res: {} as Parameters<typeof mintPaymentContinuationOnFreshAction>[0]["res"],
      journeyId: INPUT.journeyId,
      clientId: INPUT.clientId,
      requestRail: EMBEDDED_RAIL,
      response: {
        status: "started",
        clientAction: { kind: "provider_embedded", provider: EMBEDDED_RAIL, clientSecret: "secret" },
      },
      result: {
        continuationActionOrigin: "fresh_execution",
        executionRail: EMBEDDED_RAIL,
        paymentAttemptId: INPUT.paymentAttemptId,
        paymentIntentId: INPUT.paymentIntentId,
        orderId: INPUT.orderId,
      },
    });

    expect(warn).toHaveBeenCalledWith(
      "checkout_payment_continuation_unavailable",
      JSON.stringify({ executionRail: EMBEDDED_RAIL, reason: "no_signing_secret" }),
    );
    // Rail and reason only: an operator log must not carry order, client,
    // attempt or intent identifiers.
    const logged = String(warn.mock.calls[0]?.[1]);
    for (const id of [INPUT.orderId, INPUT.clientId, INPUT.paymentIntentId, INPUT.paymentAttemptId, INPUT.journeyId]) {
      expect(logged).not.toContain(id);
    }
    warn.mockRestore();
  });
});

describe("continuation TTL invariant", () => {
  it("covers the whole window the reconciliation cron may still be holding the attempt", () => {
    // ⛔ This used to read 900 and justify it as the cron's claim threshold
    // (`DEFAULT_STALE_AFTER_SECONDS`), concluding that RAISING the TTL bought
    // nothing. That reasoning was incomplete, and the incomplete half is where
    // buyers were lost: the worker becomes ELIGIBLE at 15 minutes and adopters must configure
    // a maximum reconciliation lag of 30 minutes or less, so the attempt is claimed no later than 45 minutes after acknowledgement — and for
    // that entire span the provider-attempt admission gate refuses a second
    // provider call. A 15-minute continuation expired INSIDE the window the gate
    // was still holding, so the buyer had no route back at all: expired marker →
    // discarded, every re-submit → `provider_attempt_in_flight`.
    //
    // 45 minutes covers that hold and widens double-charge exposure by nothing:
    // the self-healing does not depend on the TTL. A terminal status discards the
    // marker on the next read, and the active-action resolver re-verifies the
    // attempt identity either side of the provider read, so a marker can only be
    // redeemed against the attempt it was minted for. The portable invariant is provider-attempt admission, not deployment cadence.
    //
    // Pinned as an exact value rather than compared across the boundary, because
    // commerce may not read the payment domain's internals (see
    // `architectureGuardrails.test.ts`). The other half of the pair is pinned in
    // `paymentProviderReconciliationWorker.test.ts`, which names this file back.
    expect(CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS).toBe(2700);
  });

  it("pins the codec's own ceiling to the same shared constant", () => {
    const codec = createCheckoutPaymentContinuationCodec("s".repeat(32), {
      ttlSeconds: CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });

    expect(codec?.issue(INPUT).setCookie)
      .toContain(`Max-Age=${CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS}`);
    expect(() => createCheckoutPaymentContinuationCodec("s".repeat(32), {
      ttlSeconds: CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS + 1,
    })).toThrow(/TTL/);
  });
});
