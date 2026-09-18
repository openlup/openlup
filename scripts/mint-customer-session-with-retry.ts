// Fixture-only helper. Minting a customer session programmatically is a
// generate-magic-link → verify-OTP dance against live Supabase GoTrue. The link
// is single-use and short-lived, so under heavy preview load it can be consumed
// or expire between the two calls, and GoTrue throttles generate/verify under
// email rate limits. Both surface as "Email link is invalid or has expired",
// which intermittently fails "Provision customer account fixture" on the staging
// deploy. This wraps the dance in a bounded retry that always regenerates a FRESH
// link per attempt (never re-verifies a consumed token) and backs off harder on
// throttle. The happy path stays a single generate+verify with no sleep.
//
// This is test-tooling resilience only. The product magic-link flow (email GET
// `/auth/v1/verify` with the hash under `token`, guarded by #1034) is untouched;
// callers still exchange the JS-API `token_hash` exactly as before.

export type AuthResult<T> = { data: T; error: unknown };

export type MintSessionData = {
  session?: { access_token?: string | null } | null;
  user?: { id?: string | null } | null;
};

export type MintCustomerSessionSteps = {
  // Generate a FRESH single-use magic-link token hash. Invoked once per attempt
  // so a retry never re-verifies an already-consumed token.
  generateTokenHash: () => Promise<string>;
  // Exchange the token hash for a session (JS-API `verifyOtp({ token_hash })`).
  verify: (tokenHash: string) => Promise<AuthResult<MintSessionData>>;
};

export type MintCustomerSessionResult = {
  accessToken: string;
  userId: string;
  attempts: number;
};

export type MintRetryOptions = {
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  throttleDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; throttled: boolean; error: unknown }) => void;
};

// Deterministic, fast-on-happy-path backoff. A consumed/expired link resolves on
// the very next fresh generate, so its delays are short; throttle needs the email
// rate-limit window to reopen, so its delays are much longer.
const DEFAULT_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
const DEFAULT_THROTTLE_DELAYS_MS = [4_000, 8_000, 16_000] as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function mintCustomerSessionWithRetry(
  steps: MintCustomerSessionSteps,
  options: MintRetryOptions = {},
): Promise<MintCustomerSessionResult> {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const throttleDelays = options.throttleDelaysMs ?? DEFAULT_THROTTLE_DELAYS_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? retryDelays.length + 1);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const tokenHash = await steps.generateTokenHash();
      const verified = await steps.verify(tokenHash);
      if (verified.error) throw verified.error;
      const accessToken = verified.data.session?.access_token ?? null;
      const userId = verified.data.user?.id ?? null;
      if (!accessToken || !userId) {
        // A missing session with no error is not a transient link problem, so do
        // not retry it — surface the contract break immediately.
        throw new NonRetryableMintError("Supabase verifyOtp did not return a customer session");
      }
      return { accessToken, userId, attempts };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableMintError(error)) break;
      const throttled = isThrottleError(error);
      const delays = throttled ? throttleDelays : retryDelays;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      options.onRetry?.({ attempt, throttled, error });
      await sleep(delay);
    }
  }

  const { status, code, message } = readAuthError(lastError);
  const detail = status ? ` (status ${status}${code ? `, ${code}` : ""})` : code ? ` (${code})` : "";
  throw new Error(
    `magic-link customer session mint failed after ${attempts} attempt(s): ${message}${detail}`,
  );
}

class NonRetryableMintError extends Error {
  readonly nonRetryable = true;
}

type ReadAuthError = { status: number | null; code: string; message: string; name: string };

function readAuthError(error: unknown): ReadAuthError {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const rawStatus = record.status ?? record.statusCode;
  const parsedStatus =
    typeof rawStatus === "number" ? rawStatus : typeof rawStatus === "string" ? Number(rawStatus) : NaN;
  const status = Number.isFinite(parsedStatus) ? parsedStatus : null;
  const code = typeof record.code === "string" ? record.code : "";
  const message =
    typeof record.message === "string"
      ? record.message
      : error instanceof Error
        ? error.message
        : String(error ?? "unknown error");
  const name = typeof record.name === "string" ? record.name : error instanceof Error ? error.name : "";
  return { status, code, message, name };
}

export function isThrottleError(error: unknown): boolean {
  const { status, code, message } = readAuthError(error);
  if (status === 429) return true;
  return /rate.?limit|too many requests|email[_ ]?quota|over_email_send/i.test(`${code} ${message}`);
}

// A single-use link consumed or expired between generate and verify, or a raced
// generate. GoTrue returns these as 401/403/410 with codes like `otp_expired`
// and the message "Email link is invalid or has expired".
export function isConsumedOrExpiredLinkError(error: unknown): boolean {
  const { status, code, message } = readAuthError(error);
  if (/otp_expired|otp_disabled|bad_jwt|validation_failed|flow_state_expired/i.test(code)) return true;
  if (/invalid or has expired|link is invalid|token has expired|otp[_ ]?expired|expired/i.test(message)) {
    return true;
  }
  return status === 401 || status === 403 || status === 410;
}

// GoTrue's own transient fetch/5xx signal, mirroring the classifier already used
// by scripts/smoke-customer-subscription-auth-retry.ts.
export function isTransientFetchError(error: unknown): boolean {
  const { status, name } = readAuthError(error);
  return /AuthRetryableFetchError|Retryable|FetchError/i.test(name) || (status !== null && status >= 500);
}

export function isRetryableMintError(error: unknown): boolean {
  if (error instanceof NonRetryableMintError) return false;
  return isThrottleError(error) || isConsumedOrExpiredLinkError(error) || isTransientFetchError(error);
}
