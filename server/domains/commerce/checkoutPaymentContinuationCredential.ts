import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckoutClientAction } from "../../../src/domains/commerce/checkoutContracts.js";
import {
  PAYMENT_EXECUTION_PROVIDERS,
  type PaymentExecutionProvider,
} from "../../../src/domains/payment/types.js";
import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "../../../src/domains/commerce/paymentContinuationContracts.js";

type PspProviderKind = Extract<PaymentExecutionProvider, "stripe" | "tpay">;
const PSP_PAYMENT_EXECUTION_RAILS = PAYMENT_EXECUTION_PROVIDERS.filter(
  (rail): rail is PspProviderKind => rail === "stripe" || rail === "tpay",
);

const PURPOSE = "commerce.checkout-payment-continuation.v1" as const;
const DEFAULT_TTL_SECONDS = CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS;
const MIN_TTL_SECONDS = 60;
/**
 * The signed cookie may live exactly as long as the shared continuation TTL and
 * not a second longer, so the credential and the browser's own marker expire
 * together — one of them outliving the other is how a buyer ends up holding half
 * a continuation.
 *
 * ⛔ That TTL is deliberately NOT the reconciliation cron's claim threshold. The
 * cron becomes ELIGIBLE to claim at `DEFAULT_STALE_AFTER_SECONDS` but runs under an
 * adopter-configured maximum reconciliation lag of 30 minutes, so the attempt — and the gate refusing a second call for it
 * — is held no later than 45 minutes after acknowledgement. A credential that expired at the claim
 * threshold died inside that window, leaving the buyer with no route back.
 * `checkoutPaymentContinuationCredential.test.ts` pins the value and
 * `paymentProviderReconciliationWorker.test.ts` pins the cron half.
 */
const MAX_TTL_SECONDS = CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOURNEY_PATTERN = /^checkout:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CHECKOUT_PAYMENT_CONTINUATION_COOKIE = "__Host-openlup_checkout_continuation";

export interface CheckoutPaymentContinuationInput {
  journeyId: string;
  orderId: string;
  clientId: string;
  paymentIntentId: string;
  paymentAttemptId: string;
  executionRail: PspProviderKind;
}

export interface CheckoutPaymentContinuationClaims extends CheckoutPaymentContinuationInput {
  version: 1;
  purpose: typeof PURPOSE;
  expiresAt: number;
}

export interface CheckoutPaymentContinuationCodec {
  issue(input: CheckoutPaymentContinuationInput): {
    claims: CheckoutPaymentContinuationClaims;
    setCookie: string;
  };
  verifyCookieHeader(cookieHeader: unknown): CheckoutPaymentContinuationClaims | null;
}

export type CheckoutPaymentContinuationMinter = (
  res: CheckoutCookieResponse,
  input: CheckoutPaymentContinuationInput,
) => void;

export interface CheckoutCookieResponse {
  getHeader?(name: string): string | number | string[] | undefined;
  setHeader(name: string, value: number | string | readonly string[]): unknown;
}

export function mintPaymentContinuationOnFreshAction(input: {
  mint?: CheckoutPaymentContinuationMinter;
  res: CheckoutCookieResponse;
  journeyId: string;
  clientId: string;
  requestRail: string;
  response: { status: string; clientAction?: CheckoutClientAction };
  result: {
    continuationActionOrigin: "fresh_execution" | null;
    executionRail: string;
    paymentAttemptId: string | null;
    paymentIntentId: string;
    orderId: string;
  };
}): void {
  const { result, response } = input;
  if (
    result.continuationActionOrigin !== "fresh_execution"
    || !result.paymentAttemptId
    || !isPspRail(result.executionRail)
    || result.executionRail !== input.requestRail
    || response.status === "price_changed"
    || !responseWantsContinuation(response, result.executionRail)
  ) return;
  // Split out from the guard above ON PURPOSE. Every condition there says "this
  // attempt does not want a continuation"; this one says "it wants one and we
  // cannot issue it", which is an operator problem and used to be
  // indistinguishable from the first. That silence is how the capability stayed
  // dormant in every environment without anyone noticing. Rail and reason only:
  // no order, client, attempt or intent id is logged.
  if (!input.mint) {
    console.warn(
      "checkout_payment_continuation_unavailable",
      JSON.stringify({ executionRail: result.executionRail, reason: "no_signing_secret" }),
    );
    return;
  }
  try {
    input.mint(input.res, {
      journeyId: input.journeyId,
      orderId: result.orderId,
      clientId: input.clientId,
      paymentIntentId: result.paymentIntentId,
      paymentAttemptId: result.paymentAttemptId,
      executionRail: result.executionRail,
    });
  } catch {
    // Continuation is best-effort; checkout success must never depend on it.
  }
}

export function createCheckoutPaymentContinuationCodec(
  rootSecret: string | undefined,
  options: { now?: () => Date; ttlSeconds?: number } = {},
): CheckoutPaymentContinuationCodec | null {
  if (!rootSecret || Buffer.byteLength(rootSecret, "utf8") < 32) return null;
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(
      `Checkout payment continuation TTL must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds`,
    );
  }
  const signingKey = createHmac("sha256", rootSecret).update(PURPOSE).digest();

  function sign(payload: string): string {
    return createHmac("sha256", signingKey).update(payload).digest("base64url");
  }

  return {
    issue(input) {
      if (!isValidInput(input)) throw new Error("Invalid checkout payment continuation input");
      const claims: CheckoutPaymentContinuationClaims = {
        version: 1,
        purpose: PURPOSE,
        expiresAt: Math.floor(now().getTime() / 1000) + ttlSeconds,
        ...input,
      };
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const token = `${payload}.${sign(payload)}`;
      return {
        claims,
        setCookie: `${CHECKOUT_PAYMENT_CONTINUATION_COOKIE}=${token}; Path=/; Max-Age=${ttlSeconds}; Secure; HttpOnly; SameSite=Strict`,
      };
    },
    verifyCookieHeader(cookieHeader) {
      const token = readCookie(cookieHeader, CHECKOUT_PAYMENT_CONTINUATION_COOKIE);
      if (!token) return null;
      const separator = token.indexOf(".");
      if (separator <= 0 || separator === token.length - 1 || token.indexOf(".", separator + 1) !== -1) return null;
      const payload = token.slice(0, separator);
      const suppliedSignature = token.slice(separator + 1);
      const expectedSignature = sign(payload);
      const supplied = Buffer.from(suppliedSignature, "utf8");
      const expected = Buffer.from(expectedSignature, "utf8");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
      try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
        if (!isValidClaims(parsed)) return null;
        if (parsed.expiresAt <= Math.floor(now().getTime() / 1000)) return null;
        return parsed;
      } catch {
        return null;
      }
    },
  };
}

function isValidInput(value: unknown): value is CheckoutPaymentContinuationInput {
  if (!isRecord(value)) return false;
  return JOURNEY_PATTERN.test(readString(value, "journeyId"))
    && UUID_PATTERN.test(readString(value, "orderId"))
    && UUID_PATTERN.test(readString(value, "clientId"))
    && UUID_PATTERN.test(readString(value, "paymentIntentId"))
    && UUID_PATTERN.test(readString(value, "paymentAttemptId"))
    && isPspRail(value.executionRail);
}

function isValidClaims(value: unknown): value is CheckoutPaymentContinuationClaims {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "clientId", "expiresAt", "journeyId", "orderId", "paymentAttemptId",
    "executionRail", "paymentIntentId", "purpose", "version",
  ].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && value.version === 1
    && value.purpose === PURPOSE
    && Number.isInteger(value.expiresAt)
    && isValidInput(value);
}

function readCookie(header: unknown, name: string): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0 && trimmed.slice(0, separator) === name) {
      return trimmed.slice(separator + 1) || null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

/**
 * Does this response describe work a continuation can still serve?
 *
 * TWO shapes qualify, and they are not the same fact. An ACTION-BEARING response
 * carries something to hand back on a refresh, which is what the credential was
 * built for (#2922) and all `payment-status` ever asks it for. An ACTIONLESS one
 * has nothing to hand back and still qualifies, because the buyer is mid-payment
 * inside their banking application and the cookie is ALSO what lets them mail
 * themselves a way out of an embedded webview
 * (`server/bff/commerce/checkout-payment-link.ts`). Refusing the second shape is
 * how the escape hatch shipped inert on the one rail that needed it most: the
 * code-entry wait panel mounts the control, and the rail that mounts it never
 * issued the credential the control requires.
 *
 * ⛔ `processing` is load-bearing, not decoration. `checkoutClientAction`
 * (`commerceCheckoutProviderPayment.ts`) is the SINGLE producer of this field and
 * emits `none` in exactly two cases: a terminal status, or Tpay with no redirect
 * URL — Stripe on `processing` is always `provider_embedded`. So the actionless
 * leg denotes exactly one thing, a dispatched Tpay BLIK code entry, and dropping
 * the status check would instead mint for an order already paid or already
 * failed. That is why the discriminator is the status and not the absent action.
 *
 * Neither leg is what proves a provider call went out. `continuationActionOrigin`
 * carries that, and the guard above already requires it.
 */
function responseWantsContinuation(
  response: { status: string; clientAction?: CheckoutClientAction },
  rail: PspProviderKind,
): boolean {
  return actionMatchesExecutionRail(response.clientAction, rail)
    || (response.clientAction?.kind === "none" && response.status === "processing");
}

function actionMatchesExecutionRail(
  action: CheckoutClientAction | undefined,
  rail: PspProviderKind,
): boolean {
  return rail === PSP_PAYMENT_EXECUTION_RAILS[0]
    ? action?.kind === "provider_embedded" && action.provider === PSP_PAYMENT_EXECUTION_RAILS[0]
    : action?.kind === "redirect";
}

function isPspRail(value: unknown): value is PspProviderKind {
  return typeof value === "string"
    && (PSP_PAYMENT_EXECUTION_RAILS as readonly string[]).includes(value);
}
