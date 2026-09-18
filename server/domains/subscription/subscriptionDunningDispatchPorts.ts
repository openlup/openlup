// Ports for the subscription dunning dispatch worker (hexagonal: the domain
// declares the ports, api/infra adapters implement them). Pure types only.

import type { PaymentFailureCustomerCause } from "@openlup/core/payment";

import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
import type { DunningEmailSendOutcome } from "./dunningDeliveryOutcome.js";
import {
  METHOD_LAST_DIGITS_SNAPSHOT_KEY,
  METHOD_SCHEME_SNAPSHOT_KEY,
} from "../payment/contracts.js";

export const DUNNING_PAYMENT_FAILED_TEMPLATE_PREFIX = "subscription-payment-failed";
export const DUNNING_PAYMENT_EXPIRED_TEMPLATE_SLUG = "subscription-payment-expired";
export const DUNNING_PAYMENT_RECOVERED_TEMPLATE_SLUG = "subscription-payment-recovered";
export const DUNNING_RENEWAL_AT_RISK_TEMPLATE_SLUG = "subscription-renewal-at-risk";

// One claimed customer dunning notification, already leased to this run
// (status='sending') by the claim RPC.
export interface ClaimedDunningNotification {
  id: string;
  // The dunning case this notice belongs to; the failure-class read keys on it.
  // Null only for a legacy or malformed row — the column itself is NOT NULL.
  caseId: string | null;
  // Fresh lease/fencing token minted on every claim or stale-lease takeover.
  claimToken: string;
  // 'payment_failed' | 'payment_expired' — selects the email body.
  notificationKind: string;
  templateSlug: string;
  // clients.id of the customer (recipient_ref for customer rows).
  clientId: string;
  // The dunning sequence attempt (1/2/3), or null for the expired notice.
  retryAttempt: number | null;
  // subscriptions.id this case belongs to; the method-facts read keys on it.
  subscriptionId: string | null;
  // Scheduled instant of the next charge, persisted in the notification payload
  // at insert (`nextRetryAt`). Present for every payment_failed row — a NULL
  // ladder slot routes the customer to payment_expired instead — and null here
  // only when the payload is legacy or malformed.
  nextRetryAt: string | null;
  // Stored "/konto/platnosc/napraw?token=<raw>" path; the worker re-localizes it.
  recoveryUrlPath: string | null;
  // Gross amount of the unpaid cycle in minor units, or null when absent.
  amountMinor: number | null;
  currency: string | null;
}

export interface DunningRecipient {
  email: string;
  firstName: string | null;
  // clients.country → email locale (resolveLocale falls back to PL).
  country?: string | null;
}

export interface DunningRecipientPort {
  // clientId -> clients row; null when the client is gone (CASCADE) or unreadable.
  resolve(clientId: string, signal: AbortSignal): Promise<DunningRecipient | null>;
}

export interface DunningStorePort {
  claimBatch(
    batchSize: number,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<ClaimedDunningNotification[]>;
  markSent(id: string, claimToken: string, deliveryId: string | null): Promise<void>;
  // status: 'queued' (retry next run) | 'failed' (terminal) | 'skipped'.
  markResult(
    id: string,
    claimToken: string,
    status: "queued" | "failed" | "skipped",
    error: string | null,
    rescheduleAt?: string | null,
  ): Promise<void>;
}

// Display facts of the stored method backing this subscription, read off the
// method-ref consent snapshot. Both halves are optional; the copy renders the
// method sentence only when both are present.
export interface DunningMethodFacts {
  scheme: string | null;
  lastDigits: string | null;
}

export interface DunningMethodFactsPort {
  // subscriptionId -> the active method ref's display facts; null when there is
  // no active ref, the snapshot carries no card facts, or the read fails.
  resolve(subscriptionId: string, signal: AbortSignal): Promise<DunningMethodFacts | null>;
}

const LAST_DIGITS_PATTERN = /^\d{2,4}$/;
const SCHEME_MAX_LENGTH = 32;

export function methodFactsFromConsentSnapshot(snapshot: unknown): DunningMethodFacts | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  const rawScheme = snapshotText(record, METHOD_SCHEME_SNAPSHOT_KEY);
  const rawDigits = snapshotText(record, METHOD_LAST_DIGITS_SNAPSHOT_KEY);
  const scheme = rawScheme && rawScheme.length <= SCHEME_MAX_LENGTH ? rawScheme : null;
  const lastDigits = rawDigits && LAST_DIGITS_PATTERN.test(rawDigits) ? rawDigits : null;
  return scheme || lastDigits ? { scheme, lastDigits } : null;
}

function snapshotText(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface DunningFailureClassPort {
  // caseId -> the neutral failure class recorded on the case, or null when the
  // case predates classification, was never classified, or the read fails.
  // Display-only, exactly like the method facts: nothing here may block a send.
  resolve(caseId: string, signal: AbortSignal): Promise<string | null>;
}

export interface DunningPaymentFailedEmailInput {
  to: string;
  firstName: string | null;
  amountLabel: string | null;
  retryAttempt: number;
  // Pre-formatted calendar day of the scheduled next charge, merchant zone.
  nextRetryDateLabel: string | null;
  // Whether the ladder scheduled a further charge for this cycle at all. Derived
  // from the REASON the charge was refused, by `ladderTerminatedByClass` — the
  // same kernel the apply body's `v_terminating_classes` guard mirrors — and
  // never from `nextRetryDateLabel` being null, which means something else
  // entirely (a retry exists, its stored instant is unusable).
  //
  // It FAILS OPEN, in four ways, because a wrong `false` withdraws a promise the
  // ladder is still keeping and would push a customer to cancel a subscription
  // about to recover on its own: an absent class, an unlisted class, a class the
  // taxonomy does not recognise, and a listed class the decision table still
  // permits retrying all leave the promise standing. So does an unread class —
  // a missing port, a case-less row or a throwing read.
  //
  // Optional so a transport written before this field renders exactly what it
  // rendered before; the worker always resolves it explicitly.
  retryScheduled?: boolean;
  methodScheme: string | null;
  methodLastDigits: string | null;
  // Why the charge was refused, in the payer-facing vocabulary. `unknown` (the
  // resolved value of an absent or unclassifiable class) renders no sentence.
  cause: PaymentFailureCustomerCause;
  recoveryUrl: string | null;
  templateSlug: string;
  notificationId: string;
  locale: Locale;
  signal: AbortSignal;
}

export interface DunningPaymentExpiredEmailInput {
  to: string;
  firstName: string | null;
  amountLabel: string | null;
  cause: PaymentFailureCustomerCause;
  recoveryUrl: string | null;
  templateSlug: string;
  notificationId: string;
  locale: Locale;
  signal: AbortSignal;
}

export interface DunningEmailPort {
  sendPaymentFailed(input: DunningPaymentFailedEmailInput): Promise<DunningEmailSendOutcome>;
  sendPaymentExpired(input: DunningPaymentExpiredEmailInput): Promise<DunningEmailSendOutcome>;
}

// ---------------------------------------------------------------------------
// Payment-recovered notice. Deliberately a SEPARATE port from `DunningEmailPort`
// rather than two more methods on it: the notification rail's compositions (the
// captured reference-adapter delivery port, every existing test double) satisfy
// `DunningEmailPort` today and must keep compiling untouched. The transport
// adapter returns an object satisfying both.
// ---------------------------------------------------------------------------

// One dunning case that has reached `recovered` inside the scan window.
export interface RecoveredDunningCase {
  // subscription_dunning_cases.id — the ledger dedupe key. A case recovers at
  // most once (UNIQUE (cycle_id) + the recovered_at CHECK), so the id alone is
  // the natural "one send, ever" key; no date bucket is needed or wanted.
  caseId: string;
  subscriptionId: string | null;
  // clients.id — resolved through the same recipient port the dispatcher uses.
  clientId: string;
  recoveredAt: string;
  // Gross amount of the recovered cycle, lifted from the case's own customer
  // notification payload — the figure the customer was already told was owed.
  // Null whenever that payload is absent or malformed; the copy drops the line.
  amountMinor: number | null;
  currency: string | null;
}

export interface RecoveredDunningCaseScanPort {
  // Cases whose status is 'recovered' and whose recovered_at falls inside the
  // window. Bounded by design: a case recovered months ago must never suddenly
  // mail, so backfilled or long-settled history stays silent.
  scanRecovered(
    windowDays: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<RecoveredDunningCase[]>;
}

export interface DunningPaymentRecoveredEmailInput {
  to: string;
  firstName: string | null;
  amountLabel: string | null;
  // Doubles as the email_sends dedupe key and the provider idempotency key.
  caseId: string;
  locale: Locale;
  signal: AbortSignal;
}

export interface DunningRecoveredEmailPort {
  // True when a non-failed email_sends row already exists for this case, which
  // makes the send a permanent no-op. A FAILED row does not count, so a failed
  // attempt is retried on the next run.
  findExistingRecoveredSend(caseId: string): Promise<boolean>;
  sendPaymentRecovered(
    input: DunningPaymentRecoveredEmailInput,
  ): Promise<DunningEmailSendOutcome>;
}

// ---------------------------------------------------------------------------
// At-risk renewal notice. Same shape of rail as the recovered notice — read
// state, mail from the ledger — and a SEPARATE port for the same reason: the
// existing compositions and doubles satisfying the two ports above must keep
// compiling untouched. The transport adapter returns an object satisfying all
// of them.
// ---------------------------------------------------------------------------

// One subscription whose next renewal is already known to be unchargeable, read
// off the subscription_method_health view.
export interface AtRiskRenewal {
  subscriptionId: string;
  // clients.id — resolved through the same recipient port the dispatcher uses.
  clientId: string;
  // ISO next_cycle_at; supplies both the printed date and the ledger key's day.
  nextCycleAt: string;
  // The view's own health_state, carried RAW rather than pre-mapped. The worker
  // maps it to a cap token and refuses anything it does not recognise, so a
  // widened view cannot start mailing a state this wave never considered.
  healthState: string;
}

export interface AtRiskRenewalScanPort {
  // Subscriptions in an unchargeable health state whose next_cycle_at falls in
  // [now+minDays, now+maxDays], already filtered of rows in an open dunning
  // case and rows the narrow activation-gap detector owns.
  scanAtRisk(
    minDays: number,
    maxDays: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<AtRiskRenewal[]>;
}

export interface DunningRenewalAtRiskEmailInput {
  to: string;
  firstName: string | null;
  // Pre-formatted calendar day of the scheduled renewal, merchant zone.
  renewalDateLabel: string | null;
  // 'mandate' | 'missing' — selects the cause sentence.
  cause: string;
  subscriptionId: string;
  // `<subscriptionId>:<cause>:<renewalDayUTC>`. Doubles as the email_sends
  // dedupe value and the provider idempotency key, and IS the durable cap: the
  // producer counts the distinct keys already written under its prefix.
  ledgerKey: string;
  locale: Locale;
  signal: AbortSignal;
}

export interface DunningAtRiskEmailPort {
  // Every non-failed email_sends dedupe value written under this prefix. The
  // producer decides send/dedupe/cap from the returned set; a FAILED row is not
  // a send, so a failed attempt neither dedupes nor consumes a cap slot.
  findAtRiskSendKeys(keyPrefix: string): Promise<string[]>;
  sendRenewalAtRisk(
    input: DunningRenewalAtRiskEmailInput,
  ): Promise<DunningEmailSendOutcome>;
}
