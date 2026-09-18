export type GithubRequest = typeof fetch;

type HeaderSource = Headers | Record<string, string | undefined> | undefined;

export type GithubFailure = {
  body?: string;
  headers?: HeaderSource;
  status?: number;
  transport?: boolean;
};

export type RetryClass = "fatal" | "rate-limit" | "transient";

export type RetryRuntime = {
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type RetryOptions = RetryRuntime & {
  label?: string;
  maxAttempts?: number;
  onRetry?: (event: { attempt: number; delayMs: number; failure: GithubFailure; label: string }) => void;
};

type GithubJsonOptions = RetryOptions & {
  kind?: "read" | "single-shot";
};

export const DEFAULT_MAX_ATTEMPTS = 4;
const TRANSIENT_BASE_DELAY_MS = 2_000;
const TRANSIENT_MAX_DELAY_MS = 30_000;
const RATE_LIMIT_MINIMUM_MS = 60_000;
const RATE_LIMIT_JITTER_MS = 1_000;

export class GithubApiError extends Error {
  readonly failure: GithubFailure;

  constructor(status: number, url: string, body: string, headers: Headers) {
    super(`GitHub API ${status} for ${new URL(url).pathname}`);
    this.name = "GithubApiError";
    this.failure = { body, headers, status };
  }
}

function header(source: HeaderSource, name: string): string | undefined {
  if (!source) return undefined;
  if (source instanceof Headers) return source.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  const entry = Object.entries(source).find(([candidate]) => candidate.toLowerCase() === wanted);
  return entry?.[1];
}

function boundedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999_999, Math.max(0, value));
}

export function failureFrom(error: unknown): GithubFailure {
  if (error instanceof GithubApiError) return error.failure;
  if (typeof error === "object" && error !== null && "failure" in error) {
    const failure = (error as { failure?: GithubFailure }).failure;
    if (failure) return failure;
  }
  const body = error instanceof Error ? error.message : String(error);
  const statusMatch = body.match(/(?:GitHub API|HTTP|status(?: code)?)[^0-9]*(\d{3})/iu);
  const transport = error instanceof Error && (
    ["AbortError", "TimeoutError", "TypeError"].includes(error.name)
    || /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|fetch failed|socket hang up/iu.test(body)
  );
  return { body, status: statusMatch ? Number(statusMatch[1]) : undefined, transport };
}

export function classifyGithubFailure(failure: GithubFailure): RetryClass {
  const status = failure.status;
  const body = failure.body ?? "";
  if (failure.transport) return "transient";
  if (status === 408 || (status !== undefined && status >= 500 && status <= 599)) return "transient";
  if (status === 429) return "rate-limit";
  if (status === 403) {
    const explicitRateLimit =
      header(failure.headers, "retry-after") !== undefined
      || header(failure.headers, "x-ratelimit-remaining") === "0"
      || /secondary rate limit|primary rate limit|abuse detection/iu.test(body);
    return explicitRateLimit ? "rate-limit" : "fatal";
  }
  return "fatal";
}

export function retryDelayMs(
  failure: GithubFailure,
  failedAttempt: number,
  runtime: Pick<RetryRuntime, "now" | "random"> = {},
): number {
  const random = runtime.random ?? Math.random;
  const now = runtime.now ?? Date.now;
  const jitter = Math.floor(boundedRandom(random) * RATE_LIMIT_JITTER_MS);
  const retryAfter = Number(header(failure.headers, "retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.ceil(retryAfter * 1_000) + jitter;
  if (header(failure.headers, "x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(header(failure.headers, "x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
      return Math.max(0, Math.ceil(resetSeconds * 1_000 - now())) + jitter;
    }
  }
  if (classifyGithubFailure(failure) === "rate-limit") {
    return RATE_LIMIT_MINIMUM_MS * 2 ** Math.max(0, failedAttempt - 1) + jitter;
  }
  const ceiling = Math.min(
    TRANSIENT_MAX_DELAY_MS,
    TRANSIENT_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1),
  );
  return Math.floor(boundedRandom(random) * ceiling);
}

export async function retryGithubOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("GitHub retry maxAttempts must be a positive integer");
  }
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const label = options.label ?? "GitHub API read";
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const failure = failureFrom(error);
      if (classifyGithubFailure(failure) === "fatal" || attempt >= maxAttempts) throw error;
      const delayMs = retryDelayMs(failure, attempt, options);
      options.onRetry?.({ attempt, delayMs, failure, label });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export async function githubJsonOnce<T>(
  request: GithubRequest,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await request(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) throw new GithubApiError(response.status, url, body.slice(0, 2_000), response.headers);
  if (body.length === 0) return undefined as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`GitHub API returned malformed JSON for ${new URL(url).pathname}`);
  }
}

export function warningLogger(event: {
  attempt: number; delayMs: number; failure: GithubFailure; label: string;
}) {
  const classification = classifyGithubFailure(event.failure);
  const status = event.failure.status ?? "transport";
  process.stderr.write(
    `::warning::${event.label} ${status} (${classification}); retrying after ${event.delayMs}ms (failed attempt ${event.attempt})\n`,
  );
}

export async function githubJsonWithRetry<T>(
  request: GithubRequest,
  url: string,
  token: string,
  init: RequestInit = {},
  options: GithubJsonOptions = {},
): Promise<T> {
  const method = String(init.method ?? "GET").toUpperCase();
  const kind = options.kind ?? (method === "GET" ? "read" : "single-shot");
  if (kind === "single-shot") return githubJsonOnce<T>(request, url, token, init);
  return retryGithubOperation(
    () => githubJsonOnce<T>(request, url, token, init),
    {
      ...options,
      label: options.label ?? `GitHub API ${method} ${new URL(url).pathname}`,
      onRetry: options.onRetry ?? warningLogger,
    },
  );
}
