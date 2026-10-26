import { createHmac, timingSafeEqual } from "node:crypto";
import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "../paymentContinuation.js";
export type CheckoutContinuationAction = { kind: string; provider?: string; clientSecret?: string; url?: string };

const PURPOSE = "commerce.checkout-payment-continuation.v1" as const;
const DEFAULT_TTL_SECONDS = CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOURNEY_PATTERN = /^checkout:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;



export interface CheckoutPaymentContinuationInput<Rail extends string = string> {
  journeyId: string;
  orderId: string;
  clientId: string;
  paymentIntentId: string;
  paymentAttemptId: string;
  executionRail: Rail;
}

export interface CheckoutPaymentContinuationClaims<Rail extends string = string> extends CheckoutPaymentContinuationInput<Rail> {
  version: 1;
  purpose: typeof PURPOSE;
  expiresAt: number;
}

export interface CheckoutPaymentContinuationCodec<Rail extends string = string> {
  issue(input: CheckoutPaymentContinuationInput<Rail>): {
    claims: CheckoutPaymentContinuationClaims<Rail>;
    setCookie: string;
  };
  verifyCookieHeader(cookieHeader: unknown): CheckoutPaymentContinuationClaims<Rail> | null;
}

export type CheckoutPaymentContinuationMinter<Rail extends string = string> = (
  res: CheckoutCookieResponse,
  input: CheckoutPaymentContinuationInput<Rail>,
) => void;

export interface CheckoutCookieResponse {
  getHeader?(name: string): string | number | string[] | undefined;
  setHeader(name: string, value: number | string | readonly string[]): unknown;
}

export function mintPaymentContinuationOnFreshAction<Rail extends string>(input: {
  mint?: CheckoutPaymentContinuationMinter<Rail>;
  res: CheckoutCookieResponse;
  journeyId: string;
  clientId: string;
  requestRail: string;
  response: { status: string; clientAction?: CheckoutContinuationAction };
  result: {
    continuationActionOrigin: "fresh_execution" | null;
    executionRail: string;
    paymentAttemptId: string | null;
    paymentIntentId: string;
    orderId: string;
  };
}, executionRails: readonly [Rail, Rail]): void {
  const { result, response } = input;
  if (
    result.continuationActionOrigin !== "fresh_execution"
    || !result.paymentAttemptId
    || !isCheckoutContinuationRail(result.executionRail, executionRails)
    || result.executionRail !== input.requestRail
    || response.status === "price_changed"
    || !responseWantsContinuation(response, result.executionRail, executionRails)
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

export function createCheckoutPaymentContinuationCodec<Rail extends string>(
  rootSecret: string | undefined,
  options: { cookieName: string; executionRails: readonly [Rail, Rail]; now?: () => Date; ttlSeconds?: number },
): CheckoutPaymentContinuationCodec<Rail> | null {
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
      if (!isValidInput(input, options.executionRails)) throw new Error("Invalid checkout payment continuation input");
      const claims: CheckoutPaymentContinuationClaims<Rail> = {
        version: 1,
        purpose: PURPOSE,
        expiresAt: Math.floor(now().getTime() / 1000) + ttlSeconds,
        ...input,
      };
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const token = `${payload}.${sign(payload)}`;
      return {
        claims,
        setCookie: `${options.cookieName}=${token}; Path=/; Max-Age=${ttlSeconds}; Secure; HttpOnly; SameSite=Strict`,
      };
    },
    verifyCookieHeader(cookieHeader) {
      const token = readCookie(cookieHeader, options.cookieName);
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
        if (!isValidClaims(parsed, options.executionRails)) return null;
        if (parsed.expiresAt <= Math.floor(now().getTime() / 1000)) return null;
        return parsed;
      } catch {
        return null;
      }
    },
  };
}

function isValidInput<Rail extends string>(value: unknown, executionRails: readonly Rail[]): value is CheckoutPaymentContinuationInput<Rail> {
  if (!isRecord(value)) return false;
  return JOURNEY_PATTERN.test(readString(value, "journeyId"))
    && UUID_PATTERN.test(readString(value, "orderId"))
    && UUID_PATTERN.test(readString(value, "clientId"))
    && UUID_PATTERN.test(readString(value, "paymentIntentId"))
    && UUID_PATTERN.test(readString(value, "paymentAttemptId"))
    && isCheckoutContinuationRail(value.executionRail, executionRails);
}

function isValidClaims<Rail extends string>(value: unknown, executionRails: readonly Rail[]): value is CheckoutPaymentContinuationClaims<Rail> {
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
    && isValidInput(value, executionRails);
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

function responseWantsContinuation<Rail extends string>(
  response: { status: string; clientAction?: CheckoutContinuationAction },
  rail: Rail,
  executionRails: readonly Rail[],
): boolean {
  return actionMatchesExecutionRail(response.clientAction, rail, executionRails)
    || (response.clientAction?.kind === "none" && response.status === "processing");
}

function actionMatchesExecutionRail<Rail extends string>(
  action: CheckoutContinuationAction | undefined,
  rail: Rail,
  executionRails: readonly Rail[],
): boolean {
  return rail === executionRails[0]
    ? action?.kind === "provider_embedded" && action.provider === executionRails[0]
    : action?.kind === "redirect";
}

export function isCheckoutContinuationRail<Rail extends string>(value: unknown, executionRails: readonly Rail[]): value is Rail {
  return typeof value === "string" && (executionRails as readonly string[]).includes(value);
}
