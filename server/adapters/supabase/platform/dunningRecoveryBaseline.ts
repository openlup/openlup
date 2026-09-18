import { selectRows, type ObservabilityEvidenceClient } from "./observabilityEvidenceQueries.js";
import type {
  DunningRecoveryBaselineProjection,
  DunningRecoveryDimension,
} from "../../../../src/domains/commerce/dunningRecoveryContracts.js";

// Recovery baseline: how much of the money that fell into dunning came back.
//
// Telemetry only. Nothing branches on this read-model - no alert threshold, no
// evaluator input, no customer-visible behavior. It exists so the recovery
// program has one number that means the same thing every time it is quoted,
// with its denominator written down next to it.

/** A dunning case, reduced to what the baseline needs. */
export type DunningRecoveryCaseRow = {
  id: string;
  status: string;
  /** Which rung of the retry ladder this case sits on. */
  retry_attempt?: number | null;
  /** The refusal class that opened the case; null on every case older than the column. */
  failure_class?: string | null;
  opened_at?: string | null;
  recovered_at?: string | null;
  expired_at?: string | null;
  payment_intent_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** The embedded payment row, which is where the rail is recorded. */
export type DunningRecoveryRailRow = { provider?: string | null };

/** The per-case amount, read from the intent the case is trying to collect. */
export type DunningRecoveryAmountRow = {
  id: string;
  amount_cents?: number | null;
  currency?: string | null;
  /**
   * A to-one embed, so it arrives as an object -- but it is read defensively as
   * object-or-array-or-absent, the way every other embed in this adapter layer
   * is, because an absent embed must yield an unknown rail rather than throw.
   */
  rail?: DunningRecoveryRailRow | DunningRecoveryRailRow[] | null;
};

/**
 * The two reads the baseline needs, injected rather than a database client, so
 * the aggregation below is a pure function of rows and the query shapes stay
 * with the other evidence queries.
 */
export type DunningRecoveryBaselineReader = {
  casesOpenedSince(windowStart: string, limit: number): Promise<DunningRecoveryCaseRow[]>;
  amountsByPaymentIntentId(paymentIntentIds: readonly string[]): Promise<DunningRecoveryAmountRow[]>;
};

export type DunningRecoveryCohort = {
  count: number;
  /** Summed in the smallest currency unit. `0` when no case in the cohort resolved an amount. */
  amountMinor: number;
};

/**
 * How a recovered case was closed, read from case metadata written by the two
 * writers that close cases today. `unattributed` is a real answer, not an
 * error: older cases predate attribution.
 */
export type DunningRecoveryAttribution = "automaticRetry" | "customerRedeem" | "unattributed";

/**
 * The published shape, declared once in the commerce contract and produced here.
 * The alias keeps this module's local name while making the compiler check, at
 * this seam, that the projection and the wire contract cannot drift apart.
 */
export type DunningRecoveryBaseline = DunningRecoveryBaselineProjection;

export const DEFAULT_RECOVERY_WINDOW_DAYS = 90;
export const DEFAULT_RECOVERY_CASE_LIMIT = 1000;
const RECOVERED_VIA_AUTOMATIC_RETRY = "payment.control.apply_result";
const RECOVERY_SOURCE_CUSTOMER_REDEEM = "subscription.recovery.hidden.v0";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Keeps each keyed read's request URL bounded; amounts are read by primary key. */
const BASELINE_AMOUNT_CHUNK = 200;

/**
 * Read side of the baseline. Deliberately not part of the watchdog snapshot:
 * this read spans months and the snapshot is a sixty-second tick.
 */
export function createDunningRecoveryBaselineReader(client: ObservabilityEvidenceClient): DunningRecoveryBaselineReader {
  return {
    casesOpenedSince: (windowStart, limit) => selectRows<DunningRecoveryCaseRow>(
      client.from<DunningRecoveryCaseRow>("subscription_dunning_cases")
        .select("id,status,retry_attempt,failure_class,opened_at,recovered_at,expired_at,payment_intent_id,metadata")
        .gte("opened_at", windowStart).order("opened_at", { ascending: false }).limit(limit),
      "subscription_dunning_cases_recovery_baseline",
    ),
    async amountsByPaymentIntentId(paymentIntentIds) {
      const rows: DunningRecoveryAmountRow[] = [];
      for (let offset = 0; offset < paymentIntentIds.length; offset += BASELINE_AMOUNT_CHUNK) {
        const chunk = paymentIntentIds.slice(offset, offset + BASELINE_AMOUNT_CHUNK);
        rows.push(...await selectRows<DunningRecoveryAmountRow>(
          // The rail rides along on the amount read as an aliased to-one embed.
          // The intent holds no provider of its own; it reaches one through the
          // NOT NULL, UNIQUE payment row it settles, so this stays one request.
          client.from<DunningRecoveryAmountRow>("commerce_payment_intents").select("id,amount_cents,currency,rail:commerce_payments!commerce_payment_intents_payment_id_fkey(provider)").in("id", chunk).limit(chunk.length),
          "commerce_payment_intents_recovery_baseline",
        ));
      }
      return rows;
    },
  };
}

export async function collectDunningRecoveryBaseline(
  reader: DunningRecoveryBaselineReader,
  options: { now: Date; windowDays?: number; caseLimit?: number },
): Promise<DunningRecoveryBaseline> {
  const windowDays = options.windowDays ?? DEFAULT_RECOVERY_WINDOW_DAYS;
  const caseLimit = options.caseLimit ?? DEFAULT_RECOVERY_CASE_LIMIT;
  const windowStart = new Date(options.now.getTime() - windowDays * DAY_MS).toISOString();
  const cases = await reader.casesOpenedSince(windowStart, caseLimit);
  const paymentIntentIds = [...new Set(cases.map((row) => row.payment_intent_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  const amounts = paymentIntentIds.length === 0 ? [] : await reader.amountsByPaymentIntentId(paymentIntentIds);
  return summarizeDunningRecoveryBaseline({
    cases,
    amounts,
    windowStart,
    windowEnd: options.now.toISOString(),
    windowDays,
    caseLimit,
  });
}

export function summarizeDunningRecoveryBaseline(input: {
  cases: readonly DunningRecoveryCaseRow[];
  amounts: readonly DunningRecoveryAmountRow[];
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  caseLimit: number;
}): DunningRecoveryBaseline {
  const amountByIntentId = new Map(input.amounts.map((row) => [row.id, row]));
  const opened = cohort();
  const recovered = cohort();
  const expired = cohort();
  const cancelled = cohort();
  const resumedUnpaid = cohort();
  const stillOpen = cohort();
  const recoveredByAttribution: Record<DunningRecoveryAttribution, DunningRecoveryCohort> = {
    automaticRetry: cohort(),
    customerRedeem: cohort(),
    unattributed: cohort(),
  };
  const currencies = new Set<string>();
  const byRung = new Map<string, DunningRecoveryDimension>();
  const byClass = new Map<string, DunningRecoveryDimension>();
  const byRail = new Map<string, DunningRecoveryDimension>();
  let amountsMissing = 0;

  for (const row of input.cases) {
    const amountRow = row.payment_intent_id ? amountByIntentId.get(row.payment_intent_id) : undefined;
    const amountMinor = typeof amountRow?.amount_cents === "number" && Number.isFinite(amountRow.amount_cents) ? amountRow.amount_cents : null;
    if (amountMinor === null) amountsMissing += 1;
    else if (typeof amountRow?.currency === "string" && amountRow.currency.length > 0) currencies.add(amountRow.currency);
    add(opened, amountMinor);
    const isRecovered = row.status === "recovered";
    if (isRecovered) {
      add(recovered, amountMinor);
      add(recoveredByAttribution[attributionOf(row.metadata)], amountMinor);
    } else if (row.status === "expired") add(expired, amountMinor);
    else if (row.status === "cancelled") add(cancelled, amountMinor);
    else if (row.status === "resumed_unpaid") add(resumedUnpaid, amountMinor);
    else add(stillOpen, amountMinor);
    // Every case reaches all three breakdowns, recovered or not: their
    // denominator is the same opened cohort the window-wide rate uses.
    slice(byRung, rungOf(row.retry_attempt), amountMinor, isRecovered);
    slice(byClass, classOf(row.failure_class), amountMinor, isRecovered);
    slice(byRail, railOf(amountRow), amountMinor, isRecovered);
  }

  const mixedCurrencies = currencies.size > 1;
  return {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    windowDays: input.windowDays,
    truncated: input.cases.length >= input.caseLimit,
    currency: currencies.size === 1 ? [...currencies][0] ?? null : null,
    mixedCurrencies,
    amountsMissing,
    opened,
    recovered,
    expired,
    cancelled,
    resumedUnpaid,
    stillOpen,
    recoveredByAttribution,
    recoveryRateByCount: opened.count === 0 ? null : recovered.count / opened.count,
    recoveryRateByAmount: mixedCurrencies || opened.amountMinor === 0 ? null : recovered.amountMinor / opened.amountMinor,
    byRung: sealed(byRung, mixedCurrencies),
    byClass: sealed(byClass, mixedCurrencies),
    byRail: sealed(byRail, mixedCurrencies),
  };
}

/** Unknown keys are named, never dropped: a slice that vanishes flatters the rest. */
const UNKNOWN_KEY = "unknown";
/** Cases opened before the class column existed. Not a class -- the absence of one. */
const UNCLASSIFIED_KEY = "unclassified";

function rungOf(retryAttempt: number | null | undefined): string {
  return typeof retryAttempt === "number" && Number.isInteger(retryAttempt) && retryAttempt >= 1
    ? String(retryAttempt)
    : UNKNOWN_KEY;
}

function classOf(failureClass: string | null | undefined): string {
  return typeof failureClass === "string" && failureClass.length > 0 ? failureClass : UNCLASSIFIED_KEY;
}

function railOf(amountRow: DunningRecoveryAmountRow | undefined): string {
  const embedded = Array.isArray(amountRow?.rail) ? amountRow?.rail[0] : amountRow?.rail;
  return typeof embedded?.provider === "string" && embedded.provider.length > 0 ? embedded.provider : UNKNOWN_KEY;
}

function slice(
  target: Map<string, DunningRecoveryDimension>,
  key: string,
  amountMinor: number | null,
  isRecovered: boolean,
): void {
  const current = target.get(key) ?? { opened: cohort(), recovered: cohort(), recoveryRateByCount: null, recoveryRateByAmount: null };
  add(current.opened, amountMinor);
  if (isRecovered) add(current.recovered, amountMinor);
  target.set(key, current);
}

/**
 * Rates are computed once, at the end, from finished cohorts. `mixedCurrencies`
 * is decided window-wide rather than per slice: a slice that happens to hold one
 * currency inside a mixed window would otherwise publish a money rate that
 * cannot be added to its neighbours.
 */
function sealed(
  source: Map<string, DunningRecoveryDimension>,
  mixedCurrencies: boolean,
): Record<string, DunningRecoveryDimension> {
  return Object.fromEntries([...source].map(([key, entry]) => [key, {
    ...entry,
    recoveryRateByCount: entry.opened.count === 0 ? null : entry.recovered.count / entry.opened.count,
    recoveryRateByAmount: mixedCurrencies || entry.opened.amountMinor === 0 ? null : entry.recovered.amountMinor / entry.opened.amountMinor,
  }]));
}

function attributionOf(metadata: Record<string, unknown> | null | undefined): DunningRecoveryAttribution {
  if (metadata?.recoveredVia === RECOVERED_VIA_AUTOMATIC_RETRY) return "automaticRetry";
  if (metadata?.source === RECOVERY_SOURCE_CUSTOMER_REDEEM) return "customerRedeem";
  return "unattributed";
}

function cohort(): DunningRecoveryCohort {
  return { count: 0, amountMinor: 0 };
}

function add(target: DunningRecoveryCohort, amountMinor: number | null): void {
  target.count += 1;
  target.amountMinor += amountMinor ?? 0;
}
