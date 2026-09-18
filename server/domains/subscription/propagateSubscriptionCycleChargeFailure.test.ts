import { describe, expect, it, vi } from "vitest";

import { customerCauseForFailureClass } from "@openlup/core/payment";
import { SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS } from "../../../src/domains/subscription/paymentMethodLifecycle.js";
import { subscriptionPaymentCauseSentence } from "../../../src/domains/subscription/subscriptionPaymentCauseCopy.js";
import {
  createSupabaseCycleChargeFailurePropagationPort,
  type FailurePropagationSupabaseClient,
} from "../../adapters/supabase/subscription/cycleChargeFailurePropagation.js";
import {
  propagateSubscriptionCycleChargeFailure,
  RENEWAL_DUNNING_PROPAGATION_FAILED_KEY,
  type FailurePropagationContext,
} from "./propagateSubscriptionCycleChargeFailure.js";

function context(overrides: Partial<FailurePropagationContext> = {}): FailurePropagationContext {
  return {
    kind: "provider_declined",
    executionIdempotencyKey: "subscription:sub_1:cycle:2026-07-01T00:00:00Z:payment-execution",
    providerIdempotencyKey: "pidem_1",
    providerRequestFingerprint: "fp_1",
    paymentIntentId: "intent_1",
    cycleId: "cycle_1",
    subscriptionId: "sub_1",
    orderUuid: "order_1",
    providerKind: "stripe",
    failureReason: "card_declined",
    occurredAt: "2026-06-29T12:00:00Z",
    ...overrides,
  };
}

interface FakeOpts {
  rpcErrors?: Record<string, { code?: string; message?: string }>;
  /** RPC name whose call throws instead of returning an `{ error }` envelope. */
  rpcThrowsFor?: string;
  applyResultErrors?: Array<{ code?: string; message?: string }>;
  cycleRow?: Record<string, unknown> | null;
  /** The durable attempt row the apply instant is anchored to, when one exists. */
  attemptRow?: Record<string, unknown> | null;
  attemptReadError?: { code?: string; message?: string };
  attemptReadThrows?: boolean;
  /** What apply_result reports back: `true` means it changed nothing this tick. */
  applyReplayed?: boolean;
}

function makeClient(opts: FakeOpts = {}) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (opts.rpcThrowsFor === fn) throw new Error(`${fn} transport exploded`);
    if (opts.rpcErrors?.[fn]) return { data: null, error: opts.rpcErrors[fn] };
    if (fn === "commerce_payment_control_apply_result") {
      const error = opts.applyResultErrors?.shift();
      if (error) return { data: null, error };
    }
    if (fn === "commerce_payment_control_record_attempt") {
      // Mirror the deployed RPC's CHECK: provider execution statuses must be
      // in-flight, with one local-only exception for failures blocked before a
      // provider call.
      const allowed = ["blocked_preflight", "sent_to_provider", "requires_action", "processing"];
      if (!allowed.includes(args.p_attempt_status as string)) {
        return {
          data: null,
          error: { code: "22023", message: "payment_control_attempt_invalid_input" },
        };
      }
      return { data: { paymentAttempt: {} }, error: null };
    }
    if (fn === "subscription_handle_payment_failure_dunning") {
      return { data: { subscriptionDunning: { caseId: "case_1" } }, error: null };
    }
    return {
      data: { paymentResult: { replayed: opts.applyReplayed === true }, paymentAttempt: {} },
      error: null,
    };
  });
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({
      data: opts.cycleRow === undefined ? { retry_attempt: 2, next_retry_at: "2026-07-03T00:00:00Z" } : opts.cycleRow,
      error: null,
    }),
  };
  // The attempt read is a DIFFERENT table from the cycle read, and the value it
  // returns decides the apply fingerprint, so the fake has to tell them apart —
  // a table-blind stub would silently prove nothing.
  const attemptFilters: Record<string, unknown> = {};
  const attemptBuilder = {
    select: () => attemptBuilder,
    eq: (column: string, value: unknown) => {
      attemptFilters[column] = value;
      return attemptBuilder;
    },
    maybeSingle: async () => {
      if (opts.attemptReadThrows === true) throw new Error("attempt read exploded");
      return { data: opts.attemptRow ?? null, error: opts.attemptReadError ?? null };
    },
  };
  const from = vi.fn((table: string) => (table === "commerce_payment_attempts" ? attemptBuilder : builder));
  const driver = { rpc, from } as unknown as FailurePropagationSupabaseClient;
  // The suite drives the SHIPPED composition: the neutral orchestration over the
  // named adapter, not the orchestration over a hand-shaped port double.
  return { client: createSupabaseCycleChargeFailurePropagationPort(driver), rpc, attemptFilters };
}

const argsOf = (rpc: ReturnType<typeof makeClient>["rpc"], fn: string) =>
  rpc.mock.calls.find((c) => c[0] === fn)?.[1] as Record<string, unknown> | undefined;

describe("propagateSubscriptionCycleChargeFailure", () => {
  it("off_session_requires_action without a prepared attempt: does not classify SCA as a failed payment", async () => {
    const { client, rpc } = makeClient();
    const result = await propagateSubscriptionCycleChargeFailure(client, context({ kind: "off_session_requires_action" }));

    expect(rpc.mock.calls.some((c) => c[0] === "commerce_payment_control_record_attempt")).toBe(false);
    expect(rpc.mock.calls.some((c) => c[0] === "commerce_payment_control_apply_result")).toBe(false);
    expect(rpc.mock.calls.some((c) => c[0] === "subscription_handle_payment_failure_dunning")).toBe(false);
    expect(result).toEqual({ dunningCaseId: null, retryAttempt: null, applyReplayed: false, dunningPropagationFailed: false });
  });

  it("off_session_requires_action with a prepared active attempt opens dunning", async () => {
    const { client, rpc } = makeClient();
    const result = await propagateSubscriptionCycleChargeFailure(
      client,
      context({
        kind: "off_session_requires_action",
        failureReason: "off_session_sca_required",
        attemptAlreadyPrepared: true,
      }),
    );

    expect(rpc.mock.calls.some((c) => c[0] === "commerce_payment_control_record_attempt")).toBe(false);
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_result_status).toBe("failed");
    expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")?.p_failure_reason).toBe("off_session_sca_required");
    expect(result).toEqual({ dunningCaseId: "case_1", retryAttempt: 2, applyReplayed: false, dunningPropagationFailed: false });
  });

  it("provider_declined with a prepared provider attempt skips duplicate record-attempt", async () => {
    const { client, rpc } = makeClient();
    await propagateSubscriptionCycleChargeFailure(
      client,
      context({ kind: "provider_declined", attemptAlreadyPrepared: true }),
    );

    expect(rpc.mock.calls.some((c) => c[0] === "commerce_payment_control_record_attempt")).toBe(false);
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_result_status).toBe("failed");
    expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")?.p_failure_reason).toBe("card_declined");
  });

  it("passes null nextRetryAt to dunning when the final retry budget is exhausted", async () => {
    const { client, rpc } = makeClient({
      cycleRow: { retry_attempt: 4, next_retry_at: null },
    });

    const result = await propagateSubscriptionCycleChargeFailure(
      client,
      context({ kind: "provider_declined", attemptAlreadyPrepared: true }),
    );

    expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")).toEqual(
      expect.objectContaining({
        p_retry_attempt: 4,
        p_next_retry_at: null,
      }),
    );
    expect(result).toEqual({ dunningCaseId: "case_1", retryAttempt: 4, applyReplayed: false, dunningPropagationFailed: false });
  });

  // The pair below is the whole point of reading the row's PRESENCE rather than
  // only its value: both rows answer `next_retry_at: null`, and they must not be
  // treated alike. The first is the store saying there is no next attempt; the
  // second is the store saying nothing at all.
  it("keeps a cleared schedule cleared: a readable cycle with no next retry is not re-derived", async () => {
    const { client, rpc } = makeClient({
      cycleRow: { retry_attempt: 1, next_retry_at: null },
    });

    await propagateSubscriptionCycleChargeFailure(
      client,
      context({ kind: "provider_declined", attemptAlreadyPrepared: true }),
    );

    // Re-deriving here would hand the case a +24h retry the cycle does not have,
    // leaving two rows about one journey with contradictory schedules.
    expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")).toEqual(
      expect.objectContaining({ p_retry_attempt: 1, p_next_retry_at: null }),
    );
  });

  it("falls back to the ladder only when the cycle row could not be read at all", async () => {
    const { client, rpc } = makeClient({ cycleRow: null });

    await propagateSubscriptionCycleChargeFailure(
      client,
      context({ kind: "provider_declined", attemptAlreadyPrepared: true }),
    );

    expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")).toEqual(
      expect.objectContaining({
        p_retry_attempt: 1,
        p_next_retry_at: "2026-06-30T12:00:00.000Z",
      }),
    );
  });

  it("preflight_block: records blocked_preflight instead of pretending the provider was called", async () => {
    const { client, rpc } = makeClient();
    await propagateSubscriptionCycleChargeFailure(
      client,
      context({ kind: "preflight_block", failureReason: "missing_provider_method_ref" }),
    );

    const recordArgs = argsOf(rpc, "commerce_payment_control_record_attempt");
    expect(recordArgs?.p_attempt_status).toBe("blocked_preflight");
    expect(recordArgs?.p_request_payload).toEqual(
      expect.objectContaining({ providerFlow: "renewal_preflight" }),
    );
    expect(recordArgs?.p_response_payload).toEqual(
      expect.objectContaining({ providerCall: false }),
    );
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_result_status).toBe("failed");
  });

  it("preflight_block: replay after apply_result failure reuses deterministic idempotency keys", async () => {
    const { client, rpc } = makeClient({
      applyResultErrors: [{ message: "apply down" }],
    });
    const ctx = context({ kind: "preflight_block", failureReason: "missing_provider_method_ref" });

    await expect(propagateSubscriptionCycleChargeFailure(client, ctx)).rejects.toThrow(
      /commerce_payment_control_apply_result failed: apply down/,
    );
    const result = await propagateSubscriptionCycleChargeFailure(client, ctx);

    const recordAttemptCalls = rpc.mock.calls
      .filter((c) => c[0] === "commerce_payment_control_record_attempt")
      .map((c) => c[1] as Record<string, unknown>);
    const applyResultCalls = rpc.mock.calls
      .filter((c) => c[0] === "commerce_payment_control_apply_result")
      .map((c) => c[1] as Record<string, unknown>);

    expect(recordAttemptCalls).toHaveLength(2);
    expect(applyResultCalls).toHaveLength(2);
    expect(recordAttemptCalls[0]?.p_attempt_status).toBe("blocked_preflight");
    expect(recordAttemptCalls[0]?.p_idempotency_key).toBe(recordAttemptCalls[1]?.p_idempotency_key);
    expect(applyResultCalls[0]?.p_idempotency_key).toBe(applyResultCalls[1]?.p_idempotency_key);
    expect(result).toEqual({ dunningCaseId: "case_1", retryAttempt: 2, applyReplayed: false, dunningPropagationFailed: false });
  });

  it("surfaces an apply_result RPC error for customer-actionable preflight failures", async () => {
    const { client } = makeClient({
      rpcErrors: { commerce_payment_control_apply_result: { message: "boom" } },
    });
    await expect(
      propagateSubscriptionCycleChargeFailure(client, context({ kind: "preflight_block" })),
    ).rejects.toThrow(/commerce_payment_control_apply_result failed: boom/);
  });

  // ---- durable occurred_at (PR-0c poison-pill fix) -------------------------
  // apply_result fingerprints p_occurred_at, and the preflight path's execution
  // key is constant for the life of the cycle, so a clock-derived instant makes
  // the SECOND tick unapplyable forever. These pin the anchor, both directions.
  describe("durable occurred_at", () => {
    it("re-presents the same apply key with a byte-identical instant across ticks", async () => {
      const { client, rpc } = makeClient({ attemptRow: { created_at: "2026-06-29T11:59:58.123456+00:00" } });
      const ctx = context({ kind: "preflight_block", failureReason: "missing_provider_method_ref" });

      await propagateSubscriptionCycleChargeFailure(client, ctx);
      // Same row, a later tick: only the caller's clock has moved.
      await propagateSubscriptionCycleChargeFailure(client, { ...ctx, occurredAt: "2026-06-30T09:15:00Z" });

      const applyCalls = rpc.mock.calls
        .filter((c) => c[0] === "commerce_payment_control_apply_result")
        .map((c) => c[1] as Record<string, unknown>);
      expect(applyCalls).toHaveLength(2);
      expect(applyCalls[0]?.p_idempotency_key).toBe(applyCalls[1]?.p_idempotency_key);
      expect(applyCalls[0]?.p_occurred_at).toBe("2026-06-29T11:59:58.123456+00:00");
      expect(applyCalls[1]?.p_occurred_at).toBe(applyCalls[0]?.p_occurred_at);
    });

    it("anchors the dunning call to the same instant as the apply", async () => {
      const { client, rpc } = makeClient({ attemptRow: { created_at: "2026-06-29T11:59:58Z" } });
      await propagateSubscriptionCycleChargeFailure(client, context({ kind: "preflight_block" }));

      expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")?.p_occurred_at)
        .toBe(argsOf(rpc, "commerce_payment_control_apply_result")?.p_occurred_at);
    });

    it("looks the anchor up by the attempt key this execution key actually created", async () => {
      const preflight = makeClient({ attemptRow: { created_at: "2026-06-29T11:00:00Z" } });
      await propagateSubscriptionCycleChargeFailure(preflight.client, context({ kind: "preflight_block" }));
      expect(preflight.attemptFilters).toEqual({
        payment_intent_id: "intent_1",
        idempotency_key: `${context().executionIdempotencyKey}:record-attempt`,
      });

      const declined = makeClient({ attemptRow: { created_at: "2026-06-29T11:00:00Z" } });
      await propagateSubscriptionCycleChargeFailure(
        declined.client,
        context({ kind: "provider_declined", attemptAlreadyPrepared: true }),
      );
      expect(declined.attemptFilters.idempotency_key)
        .toBe(`${context().executionIdempotencyKey}:prepare-attempt`);
    });

    it("falls back to the caller clock when no attempt carries this execution key", async () => {
      // The prepare-replay path: an older non-terminal attempt is replayed under
      // a NEW execution key, so nothing durable exists for it. That path advances
      // the ladder every tick and must anchor each rung to its own instant.
      const { client, rpc } = makeClient({ attemptRow: null });
      await propagateSubscriptionCycleChargeFailure(
        client,
        context({ kind: "off_session_requires_action", attemptAlreadyPrepared: true }),
      );

      expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_occurred_at).toBe("2026-06-29T12:00:00Z");
    });

    it("reports a pure replay as such, so the batch can tell a stuck row from progress", async () => {
      // Once the instant is durable, the poisoned row STOPS throwing and starts
      // succeeding as a replay every tick. Without this flag that failure mode
      // is completely silent, which is worse than the loop it replaced.
      const replaying = makeClient({ applyReplayed: true });
      await expect(
        propagateSubscriptionCycleChargeFailure(replaying.client, context({ kind: "preflight_block" })),
      ).resolves.toMatchObject({ applyReplayed: true });

      // And the inverse, so the flag is proven to track the RPC rather than
      // being hard-wired: a real application reports progress.
      const applying = makeClient();
      await expect(
        propagateSubscriptionCycleChargeFailure(applying.client, context({ kind: "preflight_block" })),
      ).resolves.toMatchObject({ applyReplayed: false, dunningPropagationFailed: false });
    });

    it("never turns a failing anchor read into a row error", async () => {
      const errored = makeClient({ attemptReadError: { message: "read down" } });
      await expect(
        propagateSubscriptionCycleChargeFailure(errored.client, context({ kind: "preflight_block" })),
      ).resolves.toEqual({ dunningCaseId: "case_1", retryAttempt: 2, applyReplayed: false, dunningPropagationFailed: false });
      expect(argsOf(errored.rpc, "commerce_payment_control_apply_result")?.p_occurred_at)
        .toBe("2026-06-29T12:00:00Z");

      const threw = makeClient({ attemptReadThrows: true });
      await expect(
        propagateSubscriptionCycleChargeFailure(threw.client, context({ kind: "preflight_block" })),
      ).resolves.toEqual({ dunningCaseId: "case_1", retryAttempt: 2, applyReplayed: false, dunningPropagationFailed: false });
    });
  });

  // ---- dunning propagation failure (PR-0d) ---------------------------------
  // Before this wave the dunning step's failure was downgraded to a console.warn
  // and reported as `{ dunningCaseId: null }` — indistinguishable from the
  // legitimate no-case paths above. The cycle was still marked failed and still
  // had a retry scheduled, so the row read as handled everywhere an operator
  // could look, while the customer had no case, no recovery token and no email.
  describe("a dunning step that does not land", () => {
    it("does not throw — the charge already happened and the row must not be undone", async () => {
      const { client } = makeClient({
        rpcErrors: { subscription_handle_payment_failure_dunning: { code: "P0001", message: "dunning down" } },
      });

      await expect(
        propagateSubscriptionCycleChargeFailure(client, context({ kind: "preflight_block" })),
      ).resolves.toBeDefined();
    });

    it("reports a rejected dunning RPC as a propagation failure, not as an absent case", async () => {
      const { client } = makeClient({
        rpcErrors: { subscription_handle_payment_failure_dunning: { code: "P0001", message: "dunning down" } },
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await propagateSubscriptionCycleChargeFailure(client, context({ kind: "preflight_block" }));

      expect(result).toEqual({
        dunningCaseId: null,
        retryAttempt: 2,
        applyReplayed: false,
        dunningPropagationFailed: true,
      });
      // Structured and at error level: a warn is not something anyone is paged on.
      expect(errors).toHaveBeenCalledWith(
        "[subscription-renewal] dunning RPC error",
        expect.objectContaining({
          cycleId: "cycle_1",
          subscriptionId: "sub_1",
          rowOutcomeKey: RENEWAL_DUNNING_PROPAGATION_FAILED_KEY,
          reason: "dunning down",
        }),
      );
      errors.mockRestore();
    });

    it("reports a THROWN dunning RPC the same way — a transport failure hides the same customer", async () => {
      const { client } = makeClient({
        rpcThrowsFor: "subscription_handle_payment_failure_dunning",
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await propagateSubscriptionCycleChargeFailure(client, context({ kind: "preflight_block" }));

      expect(result).toEqual({
        dunningCaseId: null,
        retryAttempt: 2,
        applyReplayed: false,
        dunningPropagationFailed: true,
      });
      expect(errors).toHaveBeenCalledWith(
        "[subscription-renewal] dunning RPC threw",
        expect.objectContaining({ rowOutcomeKey: RENEWAL_DUNNING_PROPAGATION_FAILED_KEY }),
      );
      errors.mockRestore();
    });

    it("leaves the marker clear when the case actually opens", async () => {
      const { client } = makeClient();

      await expect(
        propagateSubscriptionCycleChargeFailure(client, context({ kind: "preflight_block" })),
      ).resolves.toMatchObject({ dunningCaseId: "case_1", dunningPropagationFailed: false });
    });
  });
});

describe("failure classification at the propagation seam", () => {
  // CL2 proof for the failure-cause wave. Three of this function's four callers
  // never supplied a classification, so the population whose cause is most worth
  // stating — SCA blocks and preflight blocks against a stored method — was
  // exactly the population recorded as unclassified. The seam classifies from the
  // reason key so no call site has to remember to.
  it.each([
    ["off_session_sca_required", "sca_required"],
    ["payment_method_revoked", "hard_do_not_retry"],
    ["payment_method_requires_action", "sca_required"],
    ["missing_provider_method_ref", "fix_and_retry_customer_action"],
    ["payment_method_invalid", "fix_and_retry_customer_action"],
  ])("derives a class from %s when the caller supplied none", async (failureReason, failureClass) => {
    const { client, rpc } = makeClient();
    await propagateSubscriptionCycleChargeFailure(client, context({ failureReason }));

    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_failure_class).toBe(failureClass);
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_failure_class_decided_by).toBe(
      "failure_reason_key",
    );
    expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")?.p_failure_class).toBe(
      failureClass,
    );
  });

  it("records `indeterminate` rather than nothing for an unmapped reason", async () => {
    // A change from NULL, and a deliberate one: an operator reading the column
    // can now tell "classified, nothing known" from "never classified at all".
    const { client, rpc } = makeClient();
    await propagateSubscriptionCycleChargeFailure(
      client,
      context({ failureReason: "acmerail_recurring_requires_model_o" }),
    );
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_failure_class).toBe(
      "indeterminate",
    );
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_failure_class_decided_by).toBe(
      "default",
    );
  });

  it("never overrides a caller that classified from stronger evidence", async () => {
    // The synchronous-decline path already classifies from an advice code or a
    // neutral hint. Re-deriving from the reason key would LOSE that: this
    // reason key is scheme-named and absent from the kernel table on purpose.
    const { client, rpc } = makeClient();
    await propagateSubscriptionCycleChargeFailure(
      client,
      context({
        failureReason: "blik_recurring_unsupported_bank",
        failureClassification: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
      }),
    );
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_failure_class).toBe("mandate_dead");
    expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")?.p_failure_class).toBe(
      "mandate_dead",
    );
  });

  // ---- audit scenario 1 of 2026-08-09 --------------------------------------
  //
  // A renewal refused because the stored consent cannot back an unattended charge.
  // It used to be persisted with the reason alone and no neutral hint, so this
  // seam classified it `indeterminate` by `default` and the customer was told
  // nothing at all. Wave 3g had the reason's OWNER publish what it asserts, so the
  // seam now records `mandate_dead` decided by `neutral_hint` — without the vendor
  // string ever entering the kernel's own reason table.
  //
  // The reason is read from the frozen list rather than spelled out, so the pin
  // follows the exact string chargeSubscriptionCycleOffSession.ts persists when
  // `assessMandate(...).chargeable` is false. That call site sits BEHIND the
  // delivery-alignment admission PR 2536 inserted ahead of it: a subscription
  // blocked on alignment returns earlier and never reaches this seam, which is
  // why the pin is written here and not against the orchestrator's gate order.
  describe("a mandate too unfit to charge unattended", () => {
    const mandateUnfitReason = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS
      .find((candidate) => candidate.endsWith("_requires_model_o"));

    it("is still one of the frozen preflight reasons this seam receives", () => {
      expect(mandateUnfitReason).toBeTruthy();
    });

    it("records `mandate_dead` decided by the hint, on the attempt and on the case alike", async () => {
      const { client, rpc } = makeClient();
      await propagateSubscriptionCycleChargeFailure(
        client,
        context({ kind: "preflight_block", failureReason: mandateUnfitReason! }),
      );

      const apply = argsOf(rpc, "commerce_payment_control_apply_result");
      expect(apply?.p_failure_class).toBe("mandate_dead");
      expect(apply?.p_failure_class_decided_by).toBe("neutral_hint");
      expect(argsOf(rpc, "subscription_handle_payment_failure_dunning")?.p_failure_class)
        .toBe("mandate_dead");
    });

    it("reaches the payer as the sentence naming the cause", () => {
      // The end of the line, in one assertion rather than a re-test of the chain:
      // the class the seam writes is the class the dunning case carries, which the
      // dispatch worker turns into a customer cause, which the renewal email
      // renders as this sentence. The cohort that used to be told nothing now
      // learns WHY the charge could not happen.
      const cause = customerCauseForFailureClass("mandate_dead");
      expect(cause).toBe("method_cannot_recur");
      // Locale "en" on purpose: the pin's subject is class -> cause -> sentence,
      // not the language, and the counted-token families price locale tags.
      expect(subscriptionPaymentCauseSentence("en", cause)).toContain(
        "does not let us charge you automatically",
      );
    });
  });

  it("stamps the same class on the attempt and on the case", async () => {
    // Two RPCs, one verdict. A case whose class disagrees with its attempt's is
    // the divergence this wave exists to prevent, one layer down.
    const { client, rpc } = makeClient();
    await propagateSubscriptionCycleChargeFailure(
      client,
      context({ failureReason: "off_session_sca_required" }),
    );
    expect(argsOf(rpc, "commerce_payment_control_apply_result")?.p_failure_class).toBe(
      argsOf(rpc, "subscription_handle_payment_failure_dunning")?.p_failure_class,
    );
  });
});
