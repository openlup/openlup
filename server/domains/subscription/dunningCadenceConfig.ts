// One cadence configuration for the whole dunning lifecycle.
//
// Before this existed, every schedule number the lifecycle runs on was a literal
// in whichever cron file happened to need it: the dispatcher's batch/lease/attempt
// budget, the recovered-notice recency window, the at-risk lead time, the
// courtesy reminder window, the pause-reminder batch. Reading "how often does a
// customer hear from dunning, and how far ahead" meant reading five files, and
// changing it meant editing five files that had no reason to agree.
//
// This module is the answer in ONE place, injected into the jobs rather than
// read by them from a global. The exported default carries today's shipped
// values EXACTLY, so wiring it changes no schedule; it only makes the schedule
// nameable, overridable per deployment, and testable without a cron.
//
// It is deliberately NOT the retry ladder. The ladder (24/72/168h, three slots,
// terminating) lives in the subscription kernel because the stored schedule and
// the engine must agree on it; this file governs how the JOBS sweep, not when a
// charge is retried.
//
// The money formatter sits here for the same reason the schedule does: how an
// amount is written for a payer is a fact about the deployment, not about the
// lifecycle, and a core that guesses it is wrong for everyone it did not guess.

import { currencyExponent } from "../../../src/lib/currency/currencyExponent.js";

/**
 * How an amount is written for a payer, injected rather than assumed. The
 * neutral implementation prints the ISO code and a decimal point, because a
 * core that guesses a merchant's separator and symbol is wrong for everyone it
 * did not guess; the shipped composition injects the same formatter the order
 * emails already use, so the bytes a customer reads do not change.
 */
export type DunningMoneyFormatter = (amountMinor: number, currency: string) => string;

export const neutralDunningMoneyFormatter: DunningMoneyFormatter = (amountMinor, currency) => {
  // The divisor is asked of the currency, not fixed at 100. "A hundred minor
  // units to the major unit" is false of every zero-exponent currency, and
  // getting it wrong does not throw - it rendered 12 999 yen as `129.99`, a
  // hundredth of the amount a customer owes, in a dunning notice. E2-F5 named
  // this formatter as carrying that defect and left it to whoever owned the
  // port; E2-F6 is the wave whose claim it falsified.
  //
  // Sign and magnitude are separated for the same reason the mail formatter's
  // arithmetic was replaced: `Math.floor(-2050 / 100)` is -21 while
  // `-2050 % 100` is -50, so the old expression rendered a negative amount as
  // `-21.-50`. No caller passes a negative magnitude today, which was the only
  // thing standing between that and a customer's inbox.
  //
  // The shape stays deliberately un-localized - digits, a dot, the code - which
  // is what "neutral" means here: this is the core port's default for a
  // deployment that has injected no formatter of its own, and it must not
  // acquire a reader's language it has no way to know.
  const exponent = currencyExponent(currency);
  const sign = amountMinor < 0 ? "-" : "";
  const magnitude = Math.abs(amountMinor);
  const divisor = 10 ** exponent;
  const major = Math.trunc(magnitude / divisor);
  if (exponent === 0) return `${sign}${major} ${currency}`;
  const minor = (magnitude % divisor).toString().padStart(exponent, "0");
  return `${sign}${major}.${minor} ${currency}`;
};

/** How the dispatcher claims and paces one batch of queued customer notices. */
export interface DunningDispatchCadence {
  /** Rows claimed per run. */
  batchSize: number;
  /** Lease held on a claimed row, in seconds. */
  leaseSeconds: number;
  /** Delivery attempts a row may accumulate before the claim stops returning it. */
  maxAttempts: number;
  /** Backoff applied when a transport failure is transient, in minutes. */
  transientBackoffMinutes: number;
}

/** How far back the recovered notice may look, and how many it may send. */
export interface RecoveredNoticeCadence {
  windowDays: number;
  batchSize: number;
}

/** The lead-time window a forward-looking notice is allowed to speak in. */
export interface LeadTimeCadence {
  minDays: number;
  maxDays: number;
  batchSize: number;
}

export interface DunningCadenceConfig {
  dispatch: DunningDispatchCadence;
  recovered: RecoveredNoticeCadence;
  /**
   * The at-risk warning. The far edge matches the courtesy reminder's; the near
   * edge is one day closer to the charge, because this message asks the customer
   * to DO something and the last days before a renewal are still time enough.
   */
  atRisk: LeadTimeCadence;
  /** The courtesy "your renewal is coming" reminder. */
  renewalReminder: LeadTimeCadence;
  /** The paused-subscription reminder sweep. */
  pauseReminder: { batchSize: number };
  /**
   * Notice kinds this deployment is willing to send at all. The consent gate
   * refuses anything absent from it with `cadence_not_allowed`, so a kind that
   * was never meant to run cannot start mailing because a producer was wired.
   * The default lists everything that ships today, so nothing changes.
   */
  allowedNotificationKinds: readonly string[];
}

/**
 * Every notice kind the dunning dispatcher sends today. `payment_failed` is the
 * ladder notice; `payment_expired` follows ladder exhaustion; and
 * `payment_recovery` is the operator-requested repair notice on that same case.
 */
export const DEFAULT_DUNNING_NOTIFICATION_KINDS: readonly string[] = Object.freeze([
  "payment_failed",
  "payment_expired",
  "payment_recovery",
]);

/**
 * Today's shipped values, verbatim. Injecting this changes nothing; it only
 * moves the numbers out of the cron files that happened to hold them.
 */
export const DEFAULT_DUNNING_CADENCE: DunningCadenceConfig = Object.freeze({
  dispatch: Object.freeze({
    batchSize: 25,
    leaseSeconds: 300,
    maxAttempts: 6,
    transientBackoffMinutes: 60,
  }),
  // Seven days is the recency bound: it comfortably covers a deploy gap or a
  // paused cron, and it guarantees that switching this producer on cannot mail a
  // backlog of cases recovered before it existed.
  recovered: Object.freeze({ windowDays: 7, batchSize: 50 }),
  atRisk: Object.freeze({ minDays: 2, maxDays: 5, batchSize: 100 }),
  renewalReminder: Object.freeze({ minDays: 3, maxDays: 5, batchSize: 100 }),
  pauseReminder: Object.freeze({ batchSize: 100 }),
  allowedNotificationKinds: DEFAULT_DUNNING_NOTIFICATION_KINDS,
}) as DunningCadenceConfig;
