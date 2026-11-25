import type { PaymentAttemptStatus } from "@openlup/core/payment";
import { describe, expect, it } from "vitest";
import {
  applyPendingResume,
  checkPendingResume,
  decidePendingResume,
  type PaymentProviderFacts,
  type PendingAction,
  type PendingResumeDecision,
  type StatusReading,
} from "../../src/storefront/index.js";

type Effects = Parameters<typeof applyPendingResume>[1];
type ActiveReading = Extract<StatusReading, { kind: "active" }>;
type Call = { effect: keyof Effects; argument?: unknown };

/** Provider names are opaque strings to the package, so the tests use neutral ones. */
const FIRST = "rail-first";
const SECOND = "rail-second";
const RETRYABLE: readonly PaymentAttemptStatus[] = ["blocked_preflight", "failed"];
const FACTS: PaymentProviderFacts = {
  providers: [FIRST, SECOND],
  reopenableEmbeddedProviders: [FIRST],
  retryableAttemptStatuses: RETRYABLE,
};
const bindings = { providerFacts: FACTS };

const ISSUED: PendingAction = { actionKind: "embedded", phase: "action_issued" };
const DISPATCHED: PendingAction = { actionKind: "embedded", phase: "confirm_dispatched" };
const EMBEDDED = { kind: "embedded", provider: FIRST, actionToken: "token-1" } as const;
const REDIRECT = { kind: "redirect", url: "https://payments.example/continue" } as const;

const active = (action: ActiveReading["action"], payment?: ActiveReading["payment"]): StatusReading =>
  payment === undefined ? { kind: "active", action } : { kind: "active", payment, action };
/** A value outside the declared union, as a later minor release or an untyped host could send it. */
const outside = <T>(value: unknown) => value as T;

describe("decidePendingResume", () => {
  it("discards on a terminal reading before any other rule, whatever the marker", () => {
    for (const pending of [ISSUED, DISPATCHED, { actionKind: "redirect" } as PendingAction]) {
      expect(decidePendingResume(bindings, pending, { kind: "terminal" }, SECOND)).toBe("discard");
    }
  });

  it("blocks a switched rail before the provider was called, with the embedded action's token", () => {
    expect(decidePendingResume(bindings, ISSUED, active(EMBEDDED), SECOND)).toStrictEqual({
      kind: "blocked_by_prior_attempt",
      provider: FIRST,
      actionToken: "token-1",
    });
  });

  it("blocks with a null token when the open action carries none", () => {
    expect(decidePendingResume(bindings, { actionKind: "none", phase: "action_issued" }, active({ kind: "other", provider: SECOND }), FIRST))
      .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: SECOND, actionToken: null });
    expect(decidePendingResume(bindings, ISSUED, active({ kind: "embedded", provider: FIRST }), SECOND))
      .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: null });
  });

  it("takes the open rail from the payment before the action", () => {
    // The payment names the selected rail, so nothing blocks and the action reopens.
    expect(decidePendingResume(bindings, ISSUED, active(EMBEDDED, { provider: SECOND, attemptStatus: "sent_to_provider" }), SECOND))
      .toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
    // The payment names the first rail, so the action's own provider is not the open rail.
    expect(decidePendingResume(bindings, ISSUED, active({ kind: "other", provider: SECOND }, { provider: FIRST, attemptStatus: null }), SECOND))
      .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: null });
  });

  it("falls back to the action's provider when the payment names no listed provider", () => {
    for (const payment of [{ provider: "unlisted" }, { provider: null }, {}, null]) {
      expect(decidePendingResume(bindings, ISSUED, active(EMBEDDED, payment), SECOND), JSON.stringify(payment))
        .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: "token-1" });
    }
  });

  it("finds no open rail in a redirect action, which names no provider", () => {
    expect(decidePendingResume(bindings, { actionKind: "redirect", phase: "action_issued" }, active(REDIRECT), SECOND))
      .toStrictEqual({ kind: "follow_redirect", url: REDIRECT.url });
  });

  it("does not block when the attempt status admits a new attempt", () => {
    for (const attemptStatus of RETRYABLE) {
      expect(decidePendingResume(bindings, ISSUED, active(EMBEDDED, { provider: FIRST, attemptStatus }), SECOND), attemptStatus)
        .toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
    }
  });

  it("blocks when the attempt status is absent, null or outside the retryable facts", () => {
    const statuses: unknown[] = [undefined, null, "sent_to_provider", "succeeded", "status_outside_the_union"];
    for (const attemptStatus of statuses) {
      const payment = attemptStatus === undefined
        ? { provider: FIRST }
        : { provider: FIRST, attemptStatus: outside<PaymentAttemptStatus | null>(attemptStatus) };
      expect(decidePendingResume(bindings, ISSUED, active(EMBEDDED, payment), SECOND), String(attemptStatus))
        .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: "token-1" });
    }
  });

  it("reads the retryable statuses from the provider facts it is given", () => {
    const none = { providerFacts: { ...FACTS, retryableAttemptStatuses: [] } };
    expect(decidePendingResume(none, ISSUED, active(EMBEDDED, { provider: FIRST, attemptStatus: "failed" }), SECOND))
      .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: "token-1" });
  });

  it("never blocks once the provider was called, nor without a different selection", () => {
    expect(decidePendingResume(bindings, DISPATCHED, active(EMBEDDED), SECOND))
      .toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
    for (const selection of [undefined, null, "", FIRST]) {
      expect(decidePendingResume(bindings, ISSUED, active(EMBEDDED), selection), String(selection))
        .toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
    }
  });

  it("reopens only an embedded marker's embedded action of a reopenable provider with a token", () => {
    expect(decidePendingResume(bindings, ISSUED, active(EMBEDDED))).toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
    const misses: Array<[string, PendingAction, ActiveReading["action"]]> = [
      ["a redirect marker", { actionKind: "redirect", phase: "action_issued" }, EMBEDDED],
      ["a marker with no action", { actionKind: "none", phase: "action_issued" }, EMBEDDED],
      ["a provider that is not reopenable", ISSUED, { ...EMBEDDED, provider: SECOND }],
      ["an absent token", ISSUED, { kind: "embedded", provider: FIRST }],
      ["an empty token", ISSUED, { ...EMBEDDED, actionToken: "" }],
      ["an action that is not embedded", ISSUED, { kind: "other", provider: FIRST }],
    ];
    for (const [label, pending, action] of misses) {
      expect(decidePendingResume(bindings, pending, active(action)), label).toBe("no_action_keep_marker");
    }
  });

  it("reads the reopenable providers from the provider facts it is given", () => {
    const every = { providerFacts: { ...FACTS, reopenableEmbeddedProviders: [FIRST, SECOND] } };
    expect(decidePendingResume(every, ISSUED, active({ ...EMBEDDED, provider: SECOND })))
      .toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
  });

  it("follows a redirect action only for a redirect marker", () => {
    expect(decidePendingResume(bindings, { actionKind: "redirect", phase: "action_issued" }, active(REDIRECT)))
      .toStrictEqual({ kind: "follow_redirect", url: REDIRECT.url });
    expect(decidePendingResume(bindings, ISSUED, active(REDIRECT))).toBe("no_action_keep_marker");
  });

  it("lets the phase decide when there is nothing to act on", () => {
    for (const action of [null, undefined]) {
      expect(decidePendingResume(bindings, ISSUED, active(action))).toBe("no_action_keep_marker");
      expect(decidePendingResume(bindings, DISPATCHED, active(action))).toBe("wait_on_status");
      expect(decidePendingResume(bindings, { actionKind: "embedded" }, active(action))).toBe("wait_on_status");
    }
    expect(decidePendingResume(bindings, ISSUED, { kind: "checking" })).toBe("no_action_keep_marker");
    expect(decidePendingResume(bindings, DISPATCHED, { kind: "checking" })).toBe("wait_on_status");
  });

  it("reads a reading kind it does not know as carrying no facts", () => {
    const reading = outside<StatusReading>({ kind: "reading_outside_the_union", payment: { provider: FIRST }, action: EMBEDDED });
    expect(decidePendingResume(bindings, ISSUED, reading, SECOND)).toBe("no_action_keep_marker");
    expect(decidePendingResume(bindings, DISPATCHED, reading, SECOND)).toBe("wait_on_status");
  });

  it("never reopens or follows an action kind it does not know, but counts the provider it names", () => {
    const named = outside<ActiveReading["action"]>({ kind: "action_outside_the_union", provider: SECOND, actionToken: "token-1", url: REDIRECT.url });
    expect(decidePendingResume(bindings, { actionKind: "none", phase: "action_issued" }, active(named), FIRST))
      .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: SECOND, actionToken: null });
    for (const actionKind of ["embedded", "redirect"] as const) {
      expect(decidePendingResume(bindings, { actionKind, phase: "action_issued" }, active(named), SECOND), actionKind).toBe("no_action_keep_marker");
    }
    const unnamed = outside<ActiveReading["action"]>({ kind: "action_outside_the_union" });
    expect(decidePendingResume(bindings, ISSUED, active(unnamed), SECOND)).toBe("no_action_keep_marker");
    expect(decidePendingResume(bindings, DISPATCHED, active(unnamed), SECOND)).toBe("wait_on_status");
  });

  it("reads an actionKind it does not know as none", () => {
    const pending = outside<PendingAction>({ actionKind: "kind_outside_the_union", phase: "action_issued" });
    expect(decidePendingResume(bindings, pending, active(EMBEDDED))).toBe("no_action_keep_marker");
    expect(decidePendingResume(bindings, pending, active(REDIRECT))).toBe("no_action_keep_marker");
    expect(decidePendingResume(bindings, pending, active(EMBEDDED), SECOND))
      .toStrictEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: "token-1" });
  });

  it("reads a phase it does not know as confirm_dispatched", () => {
    const pending = outside<PendingAction>({ actionKind: "embedded", phase: "phase_outside_the_union" });
    expect(decidePendingResume(bindings, pending, active(null))).toBe("wait_on_status");
    expect(decidePendingResume(bindings, pending, active(EMBEDDED), SECOND)).toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
  });
});

describe("checkPendingResume", () => {
  const NOW_SECONDS = 1_760_000_000;

  function statusHarness(reading: StatusReading | (() => Promise<StatusReading>)) {
    const reads: PendingAction[] = [];
    return {
      reads,
      run: (pending: PendingAction, selectedProvider?: string | null) =>
        checkPendingResume({
          status: {
            read: (marker) => {
              reads.push(marker);
              return typeof reading === "function" ? reading() : Promise.resolve(reading);
            },
          },
          // The last millisecond of the second: the expiry compares whole seconds.
          clock: { now: () => NOW_SECONDS * 1000 + 999 },
          providerFacts: FACTS,
        }, pending, selectedProvider),
    };
  }

  it("keeps an expired marker without a read, expired from the stamped second on", async () => {
    for (const expiresAt of [NOW_SECONDS, NOW_SECONDS - 1]) {
      const harness = statusHarness({ kind: "terminal" });
      await expect(harness.run({ ...DISPATCHED, expiresAt }), String(expiresAt)).resolves.toBe("no_action_keep_marker");
      expect(harness.reads).toEqual([]);
    }
  });

  it("reads a marker before its stamped second, and one without a numeric expiry", async () => {
    const pendings = [
      { ...DISPATCHED, expiresAt: NOW_SECONDS + 1 },
      DISPATCHED,
      outside<PendingAction>({ ...DISPATCHED, expiresAt: String(NOW_SECONDS - 1) }),
    ];
    for (const pending of pendings) {
      const harness = statusHarness({ kind: "terminal" });
      await expect(harness.run(pending), JSON.stringify(pending)).resolves.toBe("discard");
      expect(harness.reads).toHaveLength(1);
    }
  });

  it("hands the status binding the same pending object, with the host's own fields", async () => {
    const harness = statusHarness(active(null));
    const pending = { ...ISSUED, orderReference: "host-field" };
    await harness.run(pending);
    expect(harness.reads).toHaveLength(1);
    expect(harness.reads[0]).toBe(pending);
  });

  it("answers unknown, never discard or keep, when the status could not be read", async () => {
    await expect(statusHarness({ kind: "checking" }).run(ISSUED)).resolves.toBe("unknown");
    await expect(statusHarness({ kind: "checking" }).run(DISPATCHED)).resolves.toBe("wait_on_status");
  });

  it("lifts a reading kind it does not know like checking", async () => {
    const reading = outside<StatusReading>({ kind: "reading_outside_the_union" });
    await expect(statusHarness(reading).run(ISSUED)).resolves.toBe("unknown");
    await expect(statusHarness(reading).run(DISPATCHED)).resolves.toBe("wait_on_status");
  });

  it("does not lift an answer", async () => {
    await expect(statusHarness({ kind: "terminal" }).run(ISSUED)).resolves.toBe("discard");
    await expect(statusHarness(active(null)).run(ISSUED)).resolves.toBe("no_action_keep_marker");
  });

  it("passes the selection to the decision unchanged", async () => {
    await expect(statusHarness(active(EMBEDDED)).run(ISSUED, SECOND))
      .resolves.toStrictEqual({ kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: "token-1" });
    await expect(statusHarness(active(EMBEDDED)).run(ISSUED))
      .resolves.toStrictEqual({ kind: "reopen_embedded", actionToken: "token-1" });
  });

  it("propagates a thrown read", async () => {
    const failure = new Error("synthetic read failure");
    await expect(statusHarness(() => Promise.reject(failure)).run(ISSUED)).rejects.toBe(failure);
  });
});

describe("applyPendingResume", () => {
  function effects() {
    const calls: Call[] = [];
    const record = (effect: keyof Effects) => (argument?: unknown) => {
      calls.push(argument === undefined ? { effect } : { effect, argument });
    };
    const bound: Effects = {
      reopenAction: record("reopenAction"),
      followRedirect: record("followRedirect"),
      waitOnStatus: record("waitOnStatus"),
      discardMarker: record("discardMarker"),
      keepMarker: record("keepMarker"),
      blockOnPriorAttempt: record("blockOnPriorAttempt"),
      cannotCheck: record("cannotCheck"),
    };
    return { calls, bound };
  }

  it.each<[string, PendingResumeDecision, Call, boolean]>([
    ["discard", "discard", { effect: "discardMarker" }, false],
    ["no_action_keep_marker", "no_action_keep_marker", { effect: "keepMarker" }, false],
    ["unknown", "unknown", { effect: "cannotCheck" }, true],
    ["wait_on_status", "wait_on_status", { effect: "waitOnStatus" }, true],
    [
      "blocked_by_prior_attempt",
      { kind: "blocked_by_prior_attempt", provider: SECOND, actionToken: "token-2" },
      { effect: "blockOnPriorAttempt", argument: { provider: SECOND, actionToken: "token-2" } },
      true,
    ],
    ["follow_redirect", { kind: "follow_redirect", url: REDIRECT.url }, { effect: "followRedirect", argument: REDIRECT.url }, true],
    ["reopen_embedded", { kind: "reopen_embedded", actionToken: "token-1" }, { effect: "reopenAction", argument: "token-1" }, true],
  ])("maps %s to exactly one effect and its return", (_label, decision, call, actedOn) => {
    const { calls, bound } = effects();
    expect(applyPendingResume(decision, bound)).toBe(actedOn);
    expect(calls).toStrictEqual([call]);
  });

  it("reads a decision it does not know as unknown: keeps the marker, acts on nothing, halts the submit", () => {
    const decisions: unknown[] = [
      "decision_outside_the_union",
      { kind: "decision_outside_the_union", actionToken: "token-1", url: REDIRECT.url },
      null,
    ];
    for (const decision of decisions) {
      const { calls, bound } = effects();
      expect(applyPendingResume(outside<PendingResumeDecision>(decision), bound), JSON.stringify(decision)).toBe(true);
      expect(calls).toStrictEqual([{ effect: "cannotCheck" }]);
    }
  });
});
