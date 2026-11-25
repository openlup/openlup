import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPendingResume,
  continuationPhase,
  decidePendingResume,
  isContinuationExpired,
  type PendingResumeDecision,
  type PendingResumeEffects,
  readPendingContinuation,
  resolvePendingResume,
} from "./checkoutResumeGuard";
import { persistCheckoutContinuation, readCheckoutContinuation } from "./checkoutNavigation";
import { BffClientError } from "@/lib/bff/client";
import { PSP_PROVIDER_KINDS } from "@/domains/payment/pspIntegrationPlan";
import { PAYMENT_ATTEMPT_STATUSES, RETRYABLE_ATTEMPT_STATUSES } from "@/domains/payment/paymentControlTypes";
import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "@/domains/commerce/paymentContinuationContracts";

const { getCommercePaymentStatus } = vi.hoisted(() => ({
  getCommercePaymentStatus: vi.fn(),
}));

vi.mock("@/domains/commerce/commerceClient", () => ({
  getCommercePaymentStatus,
}));

const PENDING = {
  orderId: "11111111-1111-1111-1111-111111111111",
  orderRef: "order_ref",
  paymentIntentId: "22222222-2222-2222-2222-222222222222",
  clientId: "33333333-3333-3333-3333-333333333333",
  journeyId: "checkout:44444444-4444-4444-8444-444444444444",
  actionKind: "embedded" as const,
};

const NOW_SECONDS = 1_760_000_000;
const EMBEDDED_ACTION = {
  kind: "provider_embedded",
  provider: PSP_PROVIDER_KINDS[0],
  clientSecret: "pi_secret",
} as const;

function active(nextAction: unknown) {
  return { kind: "active", response: { nextAction } } as Parameters<typeof decidePendingResume>[1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2020-01-15T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/**
 * Was `isPendingResumable`, a predicate that computed the decision and threw it
 * away. Same three facts, now asserted on the decision itself: `PENDING` carries
 * no phase (read as `confirm_dispatched`) and the mocked status responses carry
 * no `nextAction`, so "resumable" here has always MEANT `wait_on_status` — the
 * one thing the caller could do with a `true`.
 */
describe("resolvePendingResume", () => {
  it.each(["paid", "failed", "expired"] as const)(
    "treats a terminal '%s' order as NOT resumable (drop the stale marker)",
    async (status) => {
      getCommercePaymentStatus.mockResolvedValue({ status });
      await expect(resolvePendingResume(PENDING)).resolves.toBe("discard");
      expect(getCommercePaymentStatus).toHaveBeenCalledWith({
        orderId: PENDING.orderId,
        paymentIntentId: PENDING.paymentIntentId,
        clientId: PENDING.clientId,
        journeyId: PENDING.journeyId,
      });
    },
  );

  it.each(["pending_provider_action", "requires_action", "processing"] as const)(
    "treats an in-flight '%s' order as resumable",
    async (status) => {
      getCommercePaymentStatus.mockResolvedValue({ status });
      await expect(resolvePendingResume(PENDING)).resolves.toBe("wait_on_status");
    },
  );

  it("stays conservative (resumable) when the status lookup throws", async () => {
    getCommercePaymentStatus.mockRejectedValue(new Error("404"));
    await expect(resolvePendingResume(PENDING)).resolves.toBe("wait_on_status");
  });

  it("answers 'unknown', never 'discard', when the status could not be read", async () => {
    // ⛔ The distinction the marker's life depends on. `decidePendingResume` maps
    // an unreadable status on an `action_issued` marker to `discard`, which is
    // right about the WAIT and fatal for the marker: dropping it deletes the only
    // route back to the action the server already issued, while the
    // anti-double-charge gate refuses every re-submit until the reconciliation
    // cron. One dropped packet must not cost a buyer their checkout.
    getCommercePaymentStatus.mockRejectedValue(new Error("network down"));
    const marker = { ...PENDING, phase: "action_issued" as const };

    // The inner decision is now `no_action_keep_marker` rather than `discard`: a
    // marker is never destroyed on a transport blip, and it is not destroyed on a
    // readable-but-actionless answer either. The lift to `unknown` is what still
    // stops the submit, which is what this case is about.
    expect(decidePendingResume(marker, { kind: "checking" })).toBe("no_action_keep_marker");
    await expect(resolvePendingResume(marker)).resolves.toBe("unknown");
  });

  it("keeps the marker when the SERVER says there is nothing to act on", async () => {
    // ⛔ This case previously expected `discard`, reasoning that a readable answer
    // with no usable action is an answer. It is - about the ACTION. It says nothing
    // about the attempt row, and the anti-double-charge gate reads the row. So the
    // answer cannot settle whether the next submit is admitted, and destroying the
    // marker on it left the buyer holding neither the action nor the status page
    // while the gate went on refusing. The submit still proceeds; the marker lives.
    getCommercePaymentStatus.mockResolvedValue({ status: "pending_provider_action" });
    await expect(
      resolvePendingResume({ ...PENDING, phase: "action_issued" }),
    ).resolves.toBe("no_action_keep_marker");
  });

  it("hands back the embedded action so the caller can reopen the panel", async () => {
    // The reason this stopped being a boolean. Routing THIS marker to the status
    // poller is what produced terminal declines on intents the issuer was never
    // asked about (the 2026-08-27 checkout dead end): the poller escalates to a live
    // provider read and an unconfirmed intent reads as `requires_payment_method`.
    getCommercePaymentStatus.mockResolvedValue({
      status: "pending_provider_action",
      nextAction: EMBEDDED_ACTION,
    });
    await expect(resolvePendingResume({ ...PENDING, phase: "action_issued" })).resolves.toEqual({
      kind: "reopen_embedded",
      clientSecret: "pi_secret",
    });
  });
});

describe("continuation expiry", () => {
  it("treats a marker with no expiry as un-expired", () => {
    // Written before expiries existed. Read as still true, because the phase
    // check — not this one — is the safety property; expiry is only its bound.
    expect(isContinuationExpired(PENDING, NOW_SECONDS)).toBe(false);
  });

  it("expires exactly at the stamped second, not after it", () => {
    const marker = { ...PENDING, expiresAt: NOW_SECONDS };
    expect(isContinuationExpired(marker, NOW_SECONDS - 1)).toBe(false);
    expect(isContinuationExpired(marker, NOW_SECONDS)).toBe(true);
  });

  it("is not resumable once expired, without consulting the server", async () => {
    // The no-request property is unchanged and deliberate. The VERDICT changed from
    // `discard` to `no_action_keep_marker`: past the TTL the reconciliation cron
    // USUALLY owns the attempt, but the claim window is 15 to 45 minutes with a
    // batch cap and a pending provider read re-queues, so "expired" is a local
    // clock rather than an answer about the payment. Nothing is resumed either way;
    // the marker simply survives to route a refusal.
    await expect(
      resolvePendingResume({ ...PENDING, expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    ).resolves.toBe("no_action_keep_marker");
    expect(getCommercePaymentStatus).not.toHaveBeenCalled();
  });

  it("stretches the client TTL across the whole window the cron may hold the attempt", () => {
    // The portable invariant is pinned here. The old 15 minutes was reasoned from
    // the worker's CLAIM threshold; adopters must configure a maximum reconciliation lag of 30 minutes or less, so the attempt — and
    // the admission gate refusing a second provider call for it — is held no later than 45 minutes after acknowledgement. Expiring at 15 dropped the marker inside that hold, which
    // left the buyer with no route back: discarded marker, and every re-submit
    // refused. The server-side ceiling is pinned to the same constant in
    // checkoutPaymentContinuationCredential.test.ts, which carries the full
    // argument for why this costs no double-charge exposure.
    expect(CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS).toBe(45 * 60);
  });
});

describe("decidePendingResume", () => {
  it("reads a marker with no phase as confirm_dispatched", () => {
    expect(continuationPhase(PENDING)).toBe("confirm_dispatched");
    expect(continuationPhase({ ...PENDING, phase: "action_issued" })).toBe("action_issued");
  });

  it("discards a terminal order whatever the phase", () => {
    for (const phase of ["action_issued", "confirm_dispatched"] as const) {
      expect(decidePendingResume({ ...PENDING, phase }, { kind: "terminal" })).toBe("discard");
    }
  });

  it("reopens a matching embedded action whatever the phase", () => {
    for (const phase of ["action_issued", "confirm_dispatched"] as const) {
      expect(decidePendingResume({ ...PENDING, phase }, active(EMBEDDED_ACTION))).toEqual({
        kind: "reopen_embedded",
        clientSecret: "pi_secret",
      });
    }
  });

  it("follows a matching redirect action", () => {
    expect(decidePendingResume(
      { ...PENDING, actionKind: "redirect", phase: "action_issued" },
      active({ kind: "redirect", url: "https://payments.example/continue" }),
    )).toEqual({ kind: "follow_redirect", url: "https://payments.example/continue" });
  });

  it.each([
    ["no action at all", null],
    ["an action for the other rail", { kind: "redirect", url: "https://payments.example/x" }],
    ["an embedded action with no client secret", { kind: "provider_embedded", provider: PSP_PROVIDER_KINDS[0] }],
  ])("keeps an action_issued marker when the status carries %s", (_label, nextAction) => {
    // The false-decline row: the provider was never called, so nothing can be
    // settling and the status poller has nothing to settle. Routing there is
    // what escalated to a live provider read of an unconfirmed intent and turned
    // `requires_payment_method` into a terminal `failed`.
    expect(decidePendingResume({ ...PENDING, phase: "action_issued" }, active(nextAction)))
      .toBe("no_action_keep_marker");
  });

  it.each([
    ["no action at all", null],
    ["an action for the other rail", { kind: "redirect", url: "https://payments.example/x" }],
  ])("keeps a confirm_dispatched marker waiting when the status carries %s", (_label, nextAction) => {
    // The buyer committed and the provider was called, so a charge may be live.
    expect(decidePendingResume({ ...PENDING, phase: "confirm_dispatched" }, active(nextAction)))
      .toBe("wait_on_status");
  });

  it("lets phase, not transport, decide an unreadable status", () => {
    // A lookup blip says nothing about whether money is moving; the phase does.
    expect(decidePendingResume({ ...PENDING, phase: "action_issued" }, { kind: "checking" }))
      .toBe("no_action_keep_marker");
    expect(decidePendingResume({ ...PENDING, phase: "confirm_dispatched" }, { kind: "checking" }))
      .toBe("wait_on_status");
  });
});

describe("an exhausted wait", () => {
  // ⛔ The asymmetry this wave rests on. Only the MOUNT resume stops navigating
  // for a stamped marker; the DECISION is deliberately unchanged, so the SUBMIT
  // resume — which reads the same decision — keeps stopping the buyer. That
  // refusal is what prevents a second attempt against an open one, and a
  // refactor that "makes both agree" is the double-charge bug.
  it("does not change what the guard decides about the payment", () => {
    const stamped = {
      ...PENDING,
      phase: "confirm_dispatched" as const,
      waitExhaustedAt: Math.floor(Date.now() / 1000),
    };
    expect(decidePendingResume(stamped, active(null))).toBe("wait_on_status");
    expect(decidePendingResume({ ...PENDING, phase: "confirm_dispatched" }, active(null)))
      .toBe("wait_on_status");
  });
});

describe("a rail the buyer no longer wants", () => {
  // Named by capability, not by vendor: this is the guarded checkout core.
  const OTHER_PROVIDER = PSP_PROVIDER_KINDS[1];
  const EMBEDDED_PROVIDER = PSP_PROVIDER_KINDS[0];
  const CODE_ENTRY_ACTION = { kind: "blik_code_prompt", provider: OTHER_PROVIDER } as const;

  it("blocks the submit on the open attempt when the buyer has switched rails", () => {
    // The reported walk: embedded panel opened, back pressed, the code-entry rail
    // chosen, submit. The decision carries what the blocking state needs to offer
    // a route out: whose attempt it is, and whether it can be finished in place.
    expect(decidePendingResume(
      { ...PENDING, phase: "action_issued" },
      active(EMBEDDED_ACTION),
      OTHER_PROVIDER,
    )).toEqual({
      kind: "blocked_by_prior_attempt",
      provider: EMBEDDED_PROVIDER,
      clientSecret: "pi_secret",
    });
  });

  it("blocks in the other direction too, where the action names its provider", () => {
    // ⚠️ Type-level only. No server code emits a code-entry action as a client
    // action today, and the active-action resolver accepts only `redirect` for a
    // non-embedded rail, so production cannot currently produce this pairing. The
    // assertion pins the rule that ANY provider-naming action is comparable, not a
    // walk a buyer can take.
    expect(decidePendingResume(
      { ...PENDING, phase: "action_issued", actionKind: "none" },
      active(CODE_ENTRY_ACTION),
      EMBEDDED_PROVIDER,
    )).toEqual({
      kind: "blocked_by_prior_attempt",
      provider: OTHER_PROVIDER,
      // No embedded secret to finish in place: status is the only forward route.
      clientSecret: null,
    });
  });

  it("still reopens the action for a buyer who changed nothing", () => {
    expect(decidePendingResume(
      { ...PENDING, phase: "action_issued" },
      active(EMBEDDED_ACTION),
      EMBEDDED_PROVIDER,
    )).toEqual({ kind: "reopen_embedded", clientSecret: "pi_secret" });
  });

  it("never blocks once the provider was called", () => {
    // ⛔ A charge may be settling here, and what the buyer has since clicked cannot
    // make it not be. The answer is whatever it was before this wave - for a live
    // action matching the marker that is `reopen_embedded`, because the existing
    // rule reopens a matching action without consulting the phase. What matters is
    // the invariant: no second attempt is opened on a committed one.
    expect(decidePendingResume(
      { ...PENDING, phase: "confirm_dispatched" },
      active(EMBEDDED_ACTION),
      OTHER_PROVIDER,
    )).toEqual({ kind: "reopen_embedded", clientSecret: "pi_secret" });
  });

  it("leaves a redirect action alone, because it does not name its provider", () => {
    // The response says a URL and nothing else, so a mismatch cannot be
    // established. Inferring one would make the client authoritative about
    // something the server never answered; the mirror case stays open instead.
    expect(decidePendingResume(
      { ...PENDING, phase: "action_issued", actionKind: "redirect" },
      active({ kind: "redirect", url: "https://psp.example/pay" }),
      EMBEDDED_PROVIDER,
    )).toEqual({ kind: "follow_redirect", url: "https://psp.example/pay" });
  });

  it("decides exactly as before when no selection is named", () => {
    // The mount-time twin passes none. Both resume moments must keep deciding the
    // same thing about the same facts.
    for (const selection of [undefined, null] as const) {
      expect(decidePendingResume(
        { ...PENDING, phase: "action_issued" },
        active(EMBEDDED_ACTION),
        selection,
      )).toEqual({ kind: "reopen_embedded", clientSecret: "pi_secret" });
    }
  });

  it("keeps an unreadable status an unreadable status", async () => {
    getCommercePaymentStatus.mockRejectedValueOnce(new Error("network"));

    expect(await resolvePendingResume({ ...PENDING, phase: "action_issued" }, OTHER_PROVIDER))
      .toBe("unknown");
  });
});

describe("applyPendingResume", () => {
  const effectNames = [
    "reopenAction", "followRedirect", "waitOnStatus", "discardMarker",
    "blockOnPriorAttempt", "keepMarker", "cannotCheck",
  ] as const;

  function spies(): PendingResumeEffects & { calledNames: () => string[] } {
    const fns = Object.fromEntries(effectNames.map((name) => [name, vi.fn()]));
    return {
      ...(fns as unknown as PendingResumeEffects),
      calledNames: () => effectNames.filter((name) => (fns[name] as ReturnType<typeof vi.fn>).mock.calls.length > 0),
    };
  }

  it.each([
    ["discard", "discard", "discardMarker", false],
    ["unknown", "unknown", "cannotCheck", true],
    ["wait_on_status", "wait_on_status", "waitOnStatus", true],
    // Answers FALSE like `discard` - the submit goes on - through an effect that
    // does not touch the marker. That difference is the whole wave: the refusal
    // handler downstream needs the marker to route with.
    ["no_action_keep_marker", "no_action_keep_marker", "keepMarker", false],
  ] as const)("maps '%s' to exactly one effect", (_label, decision, effect, actedOn) => {
    const effects = spies();
    expect(applyPendingResume(decision as PendingResumeDecision, effects)).toBe(actedOn);
    expect(effects.calledNames()).toEqual([effect]);
  });

  it("blocked_by_prior_attempt retains the marker and halts the submit", () => {
    // ⛔ THE regression this wave exists to make impossible. The previous shape of
    // this decision answered FALSE - letting the submit run on - and its effect
    // dropped the marker and bumped the attempt sequence, on the belief that a
    // fresh prepare key would clear the anti-double-charge gate. The gate reads the
    // intent's `active_attempt_id`, so the submit was refused anyway and the marker
    // that could still have reached the action or the status page was gone.
    //
    // Two assertions carry that: the answer is TRUE, so the submit stops; and
    // `discardMarker` is NOT among the effects called, so nothing on this path can
    // reach `clearCheckoutContinuation`.
    const effects = spies();
    const decision = {
      kind: "blocked_by_prior_attempt",
      provider: PSP_PROVIDER_KINDS[0],
      clientSecret: "pi_secret",
    } as const;

    expect(applyPendingResume(decision, effects)).toBe(true);
    expect(effects.calledNames()).toEqual(["blockOnPriorAttempt"]);
    expect(effects.blockOnPriorAttempt).toHaveBeenCalledWith({
      provider: PSP_PROVIDER_KINDS[0],
      clientSecret: "pi_secret",
    });
  });

  it("hands a redirect its URL, and nothing else", () => {
    // ⛔ THE unit-level falsifier. Both resume moments used to re-implement this
    // mapping, and only one of them had this row: the submit-time twin tested for
    // `reopen_embedded`, then for `"unknown"`, then for `!== "discard"` — and a
    // redirect decision fell into that last branch, which navigated to the status
    // poller and DROPPED the URL. Routing a buyer to wait on a payment they can
    // only complete on a page nobody sent them to.
    const effects = spies();
    expect(applyPendingResume(
      { kind: "follow_redirect", url: "https://payments.example/continue" },
      effects,
    )).toBe(true);
    expect(effects.followRedirect).toHaveBeenCalledWith("https://payments.example/continue");
    expect(effects.calledNames()).toEqual(["followRedirect"]);
  });

  it("hands an embedded reopen its client secret, and nothing else", () => {
    const effects = spies();
    expect(applyPendingResume({ kind: "reopen_embedded", clientSecret: "pi_secret" }, effects))
      .toBe(true);
    expect(effects.reopenAction).toHaveBeenCalledWith("pi_secret");
    expect(effects.calledNames()).toEqual(["reopenAction"]);
  });

  it("returns false ONLY for discard, because only then may a submit proceed", () => {
    // The boolean is a submit gate, not a status report: every other outcome has
    // already acted on the marker, so letting the press through would spend the
    // attempt on an `provider_attempt_in_flight` refusal.
    const acted = (decision: PendingResumeDecision) => applyPendingResume(decision, spies());
    expect(acted("discard")).toBe(false);
    for (const decision of [
      "unknown", "wait_on_status",
      { kind: "follow_redirect", url: "u" }, { kind: "reopen_embedded", clientSecret: "s" },
    ] as PendingResumeDecision[]) {
      expect(acted(decision), JSON.stringify(decision)).toBe(true);
    }
  });
});

/**
 * Characterization of the resume decision against a status that cannot be read.
 * Existing cases above pin "answers unknown, never discard", the expired marker
 * with no status request, and the one-effect-per-decision mapping; these cover
 * what they do not. Each test sets its own mock result, because the shared setup
 * does not reset a `vi.fn()` mock between tests.
 */
describe("a status that cannot be read", () => {
  const bffFailure = (code: ConstructorParameters<typeof BffClientError>[0]["code"], status: number) =>
    new BffClientError({ code, message: "synthetic failure" }, status);

  const NO_PHASE = {} as const;
  const ACTION_ISSUED = { phase: "action_issued" } as const;
  const CONFIRM_DISPATCHED = { phase: "confirm_dispatched" } as const;

  it.each([
    ["a TypeError", () => new TypeError("Failed to fetch")],
    ["a typed 503", () => bffFailure("UPSTREAM_UNAVAILABLE", 503)],
    ["a typed 500", () => bffFailure("INTERNAL", 500)],
  ])("a transport error never yields discard, for either phase: %s", async (_label, makeError) => {
    for (const [phaseLabel, phase, expected] of [
      ["action_issued", ACTION_ISSUED, "unknown"],
      ["confirm_dispatched", CONFIRM_DISPATCHED, "wait_on_status"],
      ["no phase", NO_PHASE, "wait_on_status"],
    ] as const) {
      const marker = { ...PENDING, ...phase };
      getCommercePaymentStatus.mockReset();
      getCommercePaymentStatus.mockRejectedValue(makeError());

      await expect(readPendingContinuation(marker), phaseLabel).resolves.toEqual({ kind: "checking" });
      const decision = await resolvePendingResume(marker);

      expect(decision, phaseLabel).not.toBe("discard");
      expect(decision, phaseLabel).toBe(expected);
    }
  });

  it.each([
    ["NOT_FOUND", 404],
    ["FORBIDDEN", 403],
  ] as const)("only a definitive not-found or forbidden answer is read as terminal: %s", async (code, status) => {
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockRejectedValue(bffFailure(code, status));

    await expect(readPendingContinuation(PENDING)).resolves.toEqual({ kind: "terminal" });
    await expect(resolvePendingResume(PENDING)).resolves.toBe("discard");
    await expect(resolvePendingResume({ ...PENDING, ...ACTION_ISSUED })).resolves.toBe("discard");
  });

  it.each([
    ["BAD_REQUEST", 400],
    ["UNAUTHORIZED", 401],
    ["METHOD_NOT_ALLOWED", 405],
    ["CONFLICT", 409],
    ["RATE_LIMITED", 429],
    ["INTERNAL", 500],
    ["INVALID_RESPONSE", 200],
    ["UPSTREAM_UNAVAILABLE", 503],
  ] as const)("only a definitive not-found or forbidden answer is read as terminal: %s is not", async (code, status) => {
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockRejectedValue(bffFailure(code, status));

    await expect(readPendingContinuation(PENDING)).resolves.toEqual({ kind: "checking" });
  });

  it("does not read a not-found-looking plain Error as terminal", async () => {
    // Only a typed client error carries a code; a plain Error with the same word
    // is a transport blip.
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockRejectedValue(new Error("NOT_FOUND"));

    await expect(readPendingContinuation(PENDING)).resolves.toEqual({ kind: "checking" });
  });
});

describe("a reload", () => {
  it.each([
    [
      "an action_issued marker whose status still carries the embedded action",
      "action_issued",
      { status: "pending_provider_action", nextAction: EMBEDDED_ACTION },
      { kind: "reopen_embedded", clientSecret: "pi_secret" },
    ],
    [
      "an action_issued marker whose status carries no action",
      "action_issued",
      { status: "processing" },
      "no_action_keep_marker",
    ],
    [
      "a confirm_dispatched marker whose status carries no action",
      "confirm_dispatched",
      { status: "processing" },
      "wait_on_status",
    ],
  ] as const)("reaches the same decision from the stored marker: %s", async (_label, phase, status, expected) => {
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockResolvedValue(status);
    persistCheckoutContinuation({ ...PENDING, phase });
    const markerBefore = readCheckoutContinuation();
    expect(markerBefore).not.toBeNull();
    const decisionBefore = await resolvePendingResume(markerBefore!);
    expect(decisionBefore).toEqual(expected);

    // A reload drops every module; only the stored marker survives it.
    vi.resetModules();
    const navigation = await import("./checkoutNavigation");
    const guard = await import("./checkoutResumeGuard");
    const markerAfter = navigation.readCheckoutContinuation();

    expect(markerAfter).toEqual(markerBefore);
    await expect(guard.resolvePendingResume(markerAfter!)).resolves.toEqual(decisionBefore);
  });
});

/**
 * Characterization of which provider counts as the open rail, when a retryable
 * attempt status admits a new attempt, which embedded action may be reopened,
 * and where a marker stops being true. Each case states what the code does today.
 */
describe("the open rail and the reopenable action", () => {
  // Named by position, not by vendor: this is the guarded checkout core.
  const FIRST = PSP_PROVIDER_KINDS[0];
  const SECOND = PSP_PROVIDER_KINDS[1];
  const ACTION_ISSUED = { ...PENDING, phase: "action_issued" } as const;
  const SECOND_RAIL_ACTION = { ...EMBEDDED_ACTION, provider: SECOND } as const;

  type Payment = { provider: string; attemptStatus: string | null };
  const payment = ({ provider, attemptStatus }: Payment) => ({
    intentStatus: "requires_action",
    attemptStatus,
    paymentAttemptId: "55555555-5555-4555-8555-555555555555",
    provider,
    providerPaymentId: "provider_payment",
    updatedAt: "2099-01-01T00:00:00Z",
  });
  const withPayment = (nextAction: unknown, facts: Payment) =>
    ({
      kind: "active",
      response: { nextAction, payment: payment(facts) },
    }) as Parameters<typeof decidePendingResume>[1];
  const statusRead = (nextAction: unknown, facts?: Payment) => ({
    status: "requires_action",
    nextAction,
    ...(facts ? { payment: payment(facts) } : {}),
  });

  it("takes the open rail from the payment before the action", () => {
    expect(decidePendingResume(
      ACTION_ISSUED,
      withPayment(EMBEDDED_ACTION, { provider: SECOND, attemptStatus: "sent_to_provider" }),
      SECOND,
    )).toEqual({ kind: "reopen_embedded", clientSecret: "pi_secret" });
  });

  it("falls back to the action's provider when the payment names an unlisted one", () => {
    expect(decidePendingResume(
      ACTION_ISSUED,
      withPayment(EMBEDDED_ACTION, { provider: "unlisted_rail", attemptStatus: "sent_to_provider" }),
      SECOND,
    )).toEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, clientSecret: "pi_secret" });
  });

  it.each(RETRYABLE_ATTEMPT_STATUSES)(
    "does not block when the attempt status admits a new attempt: %s",
    (attemptStatus) => {
      expect(decidePendingResume(
        ACTION_ISSUED,
        withPayment(EMBEDDED_ACTION, { provider: FIRST, attemptStatus }),
        SECOND,
      )).toEqual({ kind: "reopen_embedded", clientSecret: "pi_secret" });
    },
  );

  // Every enum status outside the retryable set, plus an absent one and one the
  // enum does not know: the gate is fail-closed, so each of them blocks, a
  // terminal `succeeded` included.
  const NON_RETRYABLE_STATUSES: readonly (string | null)[] = [
    ...PAYMENT_ATTEMPT_STATUSES.filter(
      (status) => !(RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(status),
    ),
    null,
    "status_outside_the_enum",
  ];

  it.each(NON_RETRYABLE_STATUSES.map((status) => [String(status), status] as const))(
    "blocks when the attempt status is not retryable or unknown: %s",
    (_label, attemptStatus) => {
      expect(decidePendingResume(
        ACTION_ISSUED,
        withPayment(EMBEDDED_ACTION, { provider: FIRST, attemptStatus }),
        SECOND,
      )).toEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, clientSecret: "pi_secret" });
    },
  );

  it("reopens only an embedded action of the reopenable provider", () => {
    // The action names the second listed rail, so the embedded branch does not
    // reopen it even with a secret and a matching marker; the phase decides.
    expect(decidePendingResume(ACTION_ISSUED, active(SECOND_RAIL_ACTION)))
      .toBe("no_action_keep_marker");
    expect(decidePendingResume({ ...PENDING, phase: "confirm_dispatched" }, active(SECOND_RAIL_ACTION)))
      .toBe("wait_on_status");
  });

  it("forwards the selection through resolvePendingResume and blocks", async () => {
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockResolvedValue({ status: "requires_action", nextAction: EMBEDDED_ACTION });

    await expect(resolvePendingResume(ACTION_ISSUED, SECOND)).resolves.toEqual({
      kind: "blocked_by_prior_attempt",
      provider: FIRST,
      clientSecret: "pi_secret",
    });
  });

  it("lets a retryable attempt status through resolvePendingResume", async () => {
    // The same answer the decision gives, reached through the status read: the
    // attempt status on the response is what admits the buyer's other rail.
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockResolvedValue(statusRead(
      EMBEDDED_ACTION,
      { provider: FIRST, attemptStatus: RETRYABLE_ATTEMPT_STATUSES[0] },
    ));

    await expect(resolvePendingResume(ACTION_ISSUED, SECOND)).resolves.toEqual({
      kind: "reopen_embedded",
      clientSecret: "pi_secret",
    });
  });

  it("reads the payment's provider through resolvePendingResume", async () => {
    // Without the payment the open rail is unknown for a redirect, which does not
    // name its provider, and the answer would be `follow_redirect`.
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockResolvedValue(statusRead(
      { kind: "redirect", url: "https://payments.example/continue" },
      { provider: FIRST, attemptStatus: "sent_to_provider" },
    ));

    await expect(
      resolvePendingResume({ ...ACTION_ISSUED, actionKind: "redirect" }, SECOND),
    ).resolves.toEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, clientSecret: null });
  });

  it("expires at the stamped second when resolved", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    getCommercePaymentStatus.mockReset();
    getCommercePaymentStatus.mockResolvedValue({ status: "processing" });

    await expect(resolvePendingResume({ ...PENDING, expiresAt: nowSeconds }))
      .resolves.toBe("no_action_keep_marker");
    expect(getCommercePaymentStatus).not.toHaveBeenCalled();

    await expect(resolvePendingResume({ ...PENDING, expiresAt: nowSeconds + 1 }))
      .resolves.toBe("wait_on_status");
    expect(getCommercePaymentStatus).toHaveBeenCalledTimes(1);
  });
});
