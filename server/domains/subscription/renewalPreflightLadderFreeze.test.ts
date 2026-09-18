import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentControlRuntimePort } from "../../../src/domains/commerce/ports.js";
import { nextRetryAttemptAt } from "../../../src/domains/subscription/cycleHardening.js";
import type {
  DueSubscription,
  SubscriptionRenewalPersistencePort,
} from "./chargeSubscriptionCycleOffSession.js";
import type { CycleChargeFailurePropagationPort } from "./propagateSubscriptionCycleChargeFailure.js";
import { recordSubscriptionRenewalPreflightBlock } from "./recordSubscriptionRenewalPreflightBlock.js";

/**
 * The renewal preflight-block ladder, traversed across cron ticks.
 *
 * This file was added as a photograph of a FREEZE and is kept as the pin of the
 * traversal that replaced it. Both halves matter: the assertions below say what
 * four ticks now do, and the prose says what they used to do, so nobody has to
 * reconstruct why the file exists.
 *
 * What used to happen. The charge path scopes its provider execution key by the
 * cycle's `retry_attempt` — its own module header states the rule: "Provider
 * execution keys are scoped by retry_attempt; local order/intent keys stay
 * stable. (CJ01-P)". The preflight-block path built that key from the cycle
 * alone. Every write in the failure chain derives its key from that one string,
 * so an unchanged key made each later tick a replay of the first:
 * `recordBlockedPreflightAttempt` landed on the row it had already created, so
 * the durable instant stayed the FIRST failure's; `applyFailedResult` returned
 * its stored response instead of applying, so `retry_attempt` and
 * `next_retry_at` never moved; and the dunning key,
 * `<execution key>:dunning:<retry attempt>`, had both halves frozen, so the
 * customer was told once and never again. The subscription sat on rung one of a
 * four-rung ladder forever.
 *
 * What happens now. The preflight path mints its key with the charge path's own
 * `buildExecutionIdempotencyKey`, from the cycle's current `retry_attempt`. Four
 * ticks mint four keys, so four attempt rows are created, four results apply,
 * and the cycle walks 1 -> 2 -> 3 -> 4 with `next_retry_at` at +24h, +72h,
 * +168h and finally null. A null next retry is the ladder's terminal condition:
 * downstream it closes the case as expired, pauses the subscription and mints
 * the resume link. The customer hears about each rung once.
 *
 * The store below models exactly the idempotency the real boundaries enforce,
 * and nothing else: an attempt row unique on `(payment intent, key)`, a result
 * that replays on a repeated key, a cycle whose retry state advances only on a
 * result that actually applied, and a dunning case that queues one notice per
 * new key. The ladder arithmetic is the shipped `nextRetryAttemptAt`, not a
 * copy, so this file cannot disagree with production about the cadence. The
 * database's own traversal is proven separately, in
 * `supabase/tests/subscription_renewal_preflight_ladder_test.sql`.
 */

const SUBSCRIPTION_ID = "00000000-0000-4000-8000-0000000000f1";
const CLIENT_ID = "00000000-0000-4000-8000-0000000000f2";
const CYCLE_ID = "00000000-0000-4000-8000-0000000000f3";
const ORDER_UUID = "00000000-0000-4000-8000-0000000000f4";
const INTENT_ID = "00000000-0000-4000-8000-0000000000f5";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000f6";
const DUNNING_CASE_ID = "00000000-0000-4000-8000-0000000000f7";

const SCHEDULED_AT = "2026-06-01T00:00:00.000Z";
const CYCLE_KEY = `subscription:${SUBSCRIPTION_ID}:cycle:${SCHEDULED_AT}`;
/** Customer-actionable, so the full durable dunning chain runs. */
const BLOCK_REASON = "payment_method_revoked";
const AMOUNT_MINOR = 12999;
/**
 * The deployment's settlement currency is read from the environment by
 * `acceptedCycleCurrency`, which refuses anything outside it. Pinning the
 * reserved test code here keeps this file free of any one deployment's money
 * vocabulary while still exercising the real acceptance check.
 */
const SETTLEMENT_CURRENCY = "XTS";

/**
 * The cron ticks that matter: the first failure, then each moment the ladder
 * schedules next (+24h, +72h, +168h). Each tick is the `next_retry_at` the
 * previous rung wrote, so the traversal below is the customer's actual week.
 */
const TICKS = [
  "2026-06-01T09:00:00.000Z",
  "2026-06-02T09:00:00.000Z",
  "2026-06-05T09:00:00.000Z",
  "2026-06-12T09:00:00.000Z",
] as const;

function due(): DueSubscription {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    clientId: CLIENT_ID,
    nextCycleAt: SCHEDULED_AT,
    currency: SETTLEMENT_CURRENCY,
    providerKind: "card_rail",
    providerCustomerRef: "customer_ref",
    providerMethodRef: "method_ref",
    methodKind: "card",
    payerEmail: "payer@example.invalid",
    payerName: "Payer",
  };
}

/**
 * One renewal store. Its only job is to answer the same way the durable
 * boundaries answer about repeated idempotency keys.
 */
function renewalStore() {
  const cycle = { retryAttempt: 0, nextRetryAt: null as string | null };
  /** `${paymentIntentId}|${key}` -> the instant the row was created. */
  const attemptRows = new Map<string, string>();
  /** apply-result key -> the instant it was fingerprinted with. */
  const appliedResults = new Map<string, string>();
  /** dunning key -> what the customer was told. */
  const dunningWrites = new Map<string, { retryAttempt: number; nextRetryAt: string | null }>();
  const executionKeysSeen: string[] = [];
  let now: string = TICKS[0];

  const persistence: SubscriptionRenewalPersistencePort = {
    buildCycleSnapshots: async () => ({
      cycleNumber: 7,
      retryAttempt: cycle.retryAttempt,
      providerAttemptSequence: 0,
      templateSnapshot: {},
      pricingSnapshot: {},
      orderSnapshot: {
        totals: { totalGross: { amountMinor: AMOUNT_MINOR, currency: SETTLEMENT_CURRENCY } },
      },
    }),
    createCycleOrder: async () => ({
      cycleId: CYCLE_ID,
      orderRef: `order_${ORDER_UUID}`,
      orderUuid: ORDER_UUID,
      paymentRef: `payment_${PAYMENT_ID}`,
      replayed: attemptRows.size > 0,
    }),
    preflightReservation: async () => ({ ok: true, reason: null, itemsChecked: 0, reacquired: 0 }),
    readMandateRecurringModel: async () => undefined,
    noteRowOutcome: async () => undefined,
  };

  const paymentPort = {
    createIntent: vi.fn().mockResolvedValue({
      paymentIntentId: INTENT_ID,
      paymentId: PAYMENT_ID,
      status: "created",
      replayed: false,
    }),
    recordAttempt: vi.fn(),
    applyResult: vi.fn(),
  } as unknown as PaymentControlRuntimePort;

  const chargeFailurePropagation: CycleChargeFailurePropagationPort = {
    // UNIQUE (payment_intent_id, idempotency_key): a repeat lands on the row
    // that is already there and creates nothing.
    async recordBlockedPreflightAttempt(input) {
      const rowKey = `${input.paymentIntentId}|${input.idempotencyKey}`;
      // The execution key is what everything else is derived from; recover it
      // from the suffix this boundary appends so the pin reads the real string.
      executionKeysSeen.push(input.idempotencyKey.replace(/:record-attempt$/, ""));
      if (!attemptRows.has(rowKey)) attemptRows.set(rowKey, now);
    },
    async readDurableAttemptInstant(input) {
      return attemptRows.get(`${input.paymentIntentId}|${input.attemptIdempotencyKey}`) ?? null;
    },
    // Applying fingerprints `occurredAt`; a repeated key returns the stored
    // response and moves nothing.
    async applyFailedResult(input) {
      if (appliedResults.has(input.idempotencyKey)) return { replayed: true };
      appliedResults.set(input.idempotencyKey, input.occurredAt);
      cycle.retryAttempt += 1;
      cycle.nextRetryAt = nextRetryAttemptAt(input.occurredAt, cycle.retryAttempt);
      return { replayed: false };
    },
    async readCycleRetryState() {
      return { retryAttempt: cycle.retryAttempt, nextRetryAt: cycle.nextRetryAt, rowPresent: true };
    },
    async openDunningCase(input) {
      if (!dunningWrites.has(input.idempotencyKey)) {
        dunningWrites.set(input.idempotencyKey, {
          retryAttempt: input.retryAttempt,
          nextRetryAt: input.nextRetryAt,
        });
      }
      return { status: "opened", caseId: DUNNING_CASE_ID };
    },
  };

  return {
    cycle,
    attemptRows,
    appliedResults,
    dunningWrites,
    executionKeysSeen,
    deps: {
      persistence,
      chargeFailurePropagation,
      paymentPort,
      now: () => now,
    },
    setNow(value: string) {
      now = value;
    },
  };
}

describe("renewal preflight block — ladder traversal across cron ticks", () => {
  let store: ReturnType<typeof renewalStore>;
  let results: Awaited<ReturnType<typeof recordSubscriptionRenewalPreflightBlock>>[];

  beforeEach(async () => {
    vi.stubEnv("COMMERCE_SETTLEMENT_CURRENCY", SETTLEMENT_CURRENCY);
    store = renewalStore();
    results = [];
    for (const tick of TICKS) {
      store.setNow(tick);
      results.push(await recordSubscriptionRenewalPreflightBlock(store.deps, due(), BLOCK_REASON));
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints a distinct execution idempotency key for every rung", () => {
    expect(store.executionKeysSeen).toEqual([
      `${CYCLE_KEY}:payment-execution:attempt:0`,
      `${CYCLE_KEY}:payment-execution:attempt:1`,
      `${CYCLE_KEY}:payment-execution:attempt:2`,
      `${CYCLE_KEY}:payment-execution:attempt:3`,
    ]);
    expect(new Set(store.executionKeysSeen).size).toBe(4);
  });

  it("creates a durable attempt row per rung, each carrying its own tick's instant", () => {
    expect(store.attemptRows.size).toBe(4);
    expect([...store.attemptRows.values()]).toEqual([...TICKS]);
  });

  it("applies a result on every tick and replays none of them", () => {
    expect(store.appliedResults.size).toBe(4);
    expect([...store.appliedResults.values()]).toEqual([...TICKS]);
  });

  it("walks the cycle up the ladder and off its end", () => {
    expect(store.cycle.retryAttempt).toBe(4);
    expect(store.cycle.nextRetryAt).toBeNull();
    expect(results.map((result) => result.retryAttempt)).toEqual([1, 2, 3, 4]);
  });

  it("tells the customer once per rung, at the cadence the ladder defines", () => {
    expect([...store.dunningWrites.keys()]).toEqual([
      `${CYCLE_KEY}:payment-execution:attempt:0:dunning:1`,
      `${CYCLE_KEY}:payment-execution:attempt:1:dunning:2`,
      `${CYCLE_KEY}:payment-execution:attempt:2:dunning:3`,
      `${CYCLE_KEY}:payment-execution:attempt:3:dunning:4`,
    ]);
    expect([...store.dunningWrites.values()]).toEqual([
      // +24h, +72h, +168h from each rung's own tick, then the end of the ladder.
      { retryAttempt: 1, nextRetryAt: "2026-06-02T09:00:00.000Z" },
      { retryAttempt: 2, nextRetryAt: "2026-06-05T09:00:00.000Z" },
      { retryAttempt: 3, nextRetryAt: "2026-06-12T09:00:00.000Z" },
      { retryAttempt: 4, nextRetryAt: null },
    ]);
  });

  it("reaches the end of the ladder, which is what expires the case and pauses the row", () => {
    // A null next retry IS the terminal condition: the dunning boundary reads it
    // as the end of the journey and answers with an expired case, a paused
    // subscription and a resume link. Reaching it exactly once is the whole
    // point of this traversal.
    const terminal = [...store.dunningWrites.values()].filter((write) => write.nextRetryAt === null);
    expect(terminal).toEqual([{ retryAttempt: 4, nextRetryAt: null }]);
    expect(store.cycle.nextRetryAt).toBeNull();
  });

  it("keeps every tick a real failure result for the same cycle and reason", () => {
    for (const result of results) {
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe(BLOCK_REASON);
      expect(result.cycleId).toBe(CYCLE_ID);
      expect(result.dunningCaseId).toBe(DUNNING_CASE_ID);
    }
  });
});
