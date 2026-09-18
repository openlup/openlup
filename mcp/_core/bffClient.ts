import {
  BFF_REQUEST_REFERENCE_HEADER,
  isBffRequestReference,
} from "../../src/lib/bff/contracts.js";

/** Structured error surfaced to the agent: the BFF code, the reason, and whether a retry could help. */
export interface BffToolDiagnostics {
  readonly requestId?: string;
  readonly backendRequestRefs?: readonly string[];
  readonly backendRequestRefsIncomplete?: true;
}

export class BffToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reason: string,
    readonly retryable: boolean,
    readonly details?: unknown,
    diagnostics: BffToolDiagnostics = {},
  ) {
    super(message);
    this.name = "BffToolError";
    this.requestId = diagnostics.requestId;
    this.backendRequestRefs = diagnostics.backendRequestRefs;
    this.backendRequestRefsIncomplete = diagnostics.backendRequestRefsIncomplete;
  }

  readonly requestId?: string;
  readonly backendRequestRefs?: readonly string[];
  readonly backendRequestRefsIncomplete?: true;
}

const MAX_BACKEND_REQUEST_REFS = 16;

export class BackendRequestRefContext {
  private readonly refs = new Set<string>();
  private pending = 0;
  private incomplete = false;

  begin(): void { this.pending += 1; }
  end(): void { this.pending = Math.max(0, this.pending - 1); }
  uncertain(): void { this.incomplete = true; }

  observe(res: Response, body?: unknown, untrustedRequestId?: string): void {
    const headerValue = res.headers?.get(BFF_REQUEST_REFERENCE_HEADER) ?? null;
    const meta = isRecord(body) && isRecord(body.meta) ? body.meta : undefined;
    const hasMetaValue = Boolean(meta && Object.prototype.hasOwnProperty.call(meta, "requestId"));
    const metaValue = hasMetaValue ? meta?.requestId : undefined;

    if (headerValue !== null && !isBffRequestReference(headerValue)) return this.uncertain();
    if (hasMetaValue && !isBffRequestReference(metaValue)) return this.uncertain();
    if (headerValue !== null && hasMetaValue && headerValue !== metaValue) return this.uncertain();
    const ref = isBffRequestReference(headerValue)
      ? headerValue
      : isBffRequestReference(metaValue) ? metaValue : undefined;
    if (!ref || ref === untrustedRequestId) return this.uncertain();
    if (this.refs.has(ref)) return;
    if (this.refs.size >= MAX_BACKEND_REQUEST_REFS) return this.uncertain();
    this.refs.add(ref);
  }

  snapshot(): BffToolDiagnostics {
    return {
      ...(this.refs.size > 0 ? { backendRequestRefs: [...this.refs].sort() } : {}),
      ...(this.incomplete || this.pending > 0 ? { backendRequestRefsIncomplete: true as const } : {}),
    };
  }
}

export interface BffClientDeps {
  /** Origin for the BFF, e.g. `http://localhost:3000` or a preview host. */
  readonly baseUrl: string;
  readonly getBearer: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  /** Sent as `x-contract-version`; a mismatched response is rejected loudly. */
  readonly contractVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly generateRequestId?: () => string;
  /** Server-held headers such as the staging Vercel protection bypass. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface BffClient {
  post(path: string, body: unknown, options?: BffRequestOptions): Promise<Record<string, unknown>>;
  get(path: string, query: Record<string, string | number | undefined>, options?: BffRequestOptions): Promise<Record<string, unknown>>;
}

export interface BffRequestOptions {
  readonly contractVersion?: string | null;
  readonly requestContext?: BackendRequestRefContext;
}

interface BffEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: { reason?: string } & Record<string, unknown> };
}

// Only genuinely-transient outcomes are retryable; a known rule/authz RAISE never is.
const RETRYABLE_CODES = new Set(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);

export function createBffClient(deps: BffClientDeps): BffClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const generateRequestId = deps.generateRequestId ?? (() => crypto.randomUUID());

  function headers(bearer: string, requestId: string, contractVersion: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      ...deps.extraHeaders,
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
      "x-request-id": requestId,
    };
    if (contractVersion) headers["x-contract-version"] = contractVersion;
    return headers;
  }

  function sendPost(path: string, body: unknown, bearer: string, requestId: string, contractVersion: string | null): Promise<Response> {
    return fetchImpl(joinUrl(deps.baseUrl, path), {
      method: "POST",
      headers: headers(bearer, requestId, contractVersion),
      body: JSON.stringify(body),
    });
  }

  function sendGet(url: string, bearer: string, requestId: string, contractVersion: string | null): Promise<Response> {
    return fetchImpl(url, { method: "GET", headers: headers(bearer, requestId, contractVersion) });
  }

  // Capture each response before the existing single auth-refresh retry can discard it.
  async function dispatch(
    expectedContractVersion: string | null,
    send: (bearer: string) => Promise<Response>,
    untrustedRequestId: string,
    context = new BackendRequestRefContext(),
  ): Promise<Record<string, unknown>> {
    context.begin();
    let failure: unknown;
    try {
      let bearer = await deps.getBearer();
      let res = await sendWithUncertainty(send, bearer, context);
      // An expired Bearer surfaces as 401 — re-auth once (single-flight) and retry.
      if (res.status === 401) {
        await observeDiscardedResponse(res, context, untrustedRequestId);
        bearer = await deps.getBearer({ forceRefresh: true });
        res = await sendWithUncertainty(send, bearer, context);
      }
      const envelope = await readEnvelope(res, context, untrustedRequestId);
      if (envelope.ok) {
        const data = (envelope.data ?? {}) as Record<string, unknown>;
        assertContractVersion(data, expectedContractVersion);
        return data;
      }
      throw toToolError(envelope);
    } catch (error) {
      failure = error;
    } finally {
      context.end();
    }
    throw withBackendRequestDiagnostics(failure, context.snapshot());
  }

  return {
    async post(path, body, options) {
      const requestId = generateRequestId();
      const contractVersion = options?.contractVersion === undefined ? deps.contractVersion : options.contractVersion;
      return dispatch(contractVersion, (bearer) => sendPost(path, body, bearer, requestId, contractVersion), requestId, options?.requestContext);
    },
    async get(path, query, options) {
      const requestId = generateRequestId();
      const contractVersion = options?.contractVersion === undefined ? deps.contractVersion : options.contractVersion;
      const url = withQuery(joinUrl(deps.baseUrl, path), query);
      return dispatch(contractVersion, (bearer) => sendGet(url, bearer, requestId, contractVersion), requestId, options?.requestContext);
    },
  };
}

function withQuery(url: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function readEnvelope(res: Response, context: BackendRequestRefContext, untrustedRequestId: string): Promise<BffEnvelope> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    context.observe(res, undefined, untrustedRequestId);
    throw new BffToolError(
      "UPSTREAM_UNAVAILABLE",
      `Non-JSON BFF response (HTTP ${res.status})`,
      "upstream_unavailable",
      true,
    );
  }
  context.observe(res, parsed, untrustedRequestId);
  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    throw new BffToolError(
      "UPSTREAM_UNAVAILABLE",
      `Malformed BFF envelope (HTTP ${res.status})`,
      "upstream_unavailable",
      true,
    );
  }
  return parsed as BffEnvelope;
}

async function sendWithUncertainty(
  send: (bearer: string) => Promise<Response>,
  bearer: string,
  context: BackendRequestRefContext,
): Promise<Response> {
  try {
    return await send(bearer);
  } catch (error) {
    context.uncertain();
    throw error;
  }
}

async function observeDiscardedResponse(res: Response, context: BackendRequestRefContext, untrustedRequestId: string): Promise<void> {
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    body = undefined;
  }
  context.observe(res, body, untrustedRequestId);
}

export function withBackendRequestDiagnostics(
  error: unknown,
  diagnostics: BffToolDiagnostics,
): BffToolError {
  const refs = [
    ...(error instanceof BffToolError ? error.backendRequestRefs ?? [] : []),
    ...(diagnostics.backendRequestRefs ?? []),
  ];
  const uniqueRefs = [...new Set(refs)].slice(0, MAX_BACKEND_REQUEST_REFS).sort();
  const merged = {
    ...(error instanceof BffToolError && error.requestId ? { requestId: error.requestId } : {}),
    ...(uniqueRefs.length > 0 ? { backendRequestRefs: uniqueRefs } : {}),
    ...((error instanceof BffToolError && error.backendRequestRefsIncomplete)
      || diagnostics.backendRequestRefsIncomplete
      || refs.length > MAX_BACKEND_REQUEST_REFS
      ? { backendRequestRefsIncomplete: true as const }
      : {}),
  };
  if (error instanceof BffToolError) {
    return new BffToolError(
      error.code,
      error.message,
      error.reason,
      error.retryable,
      error.details,
      merged,
    );
  }
  return new BffToolError(
    "INTERNAL",
    "Tool request failed",
    "internal_error",
    false,
    undefined,
    merged,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toToolError(envelope: BffEnvelope): BffToolError {
  const code = envelope.error?.code ?? "UPSTREAM_UNAVAILABLE";
  const reason = envelope.error?.details?.reason ?? envelope.error?.message ?? "upstream_unavailable";
  const message = envelope.error?.message ?? reason;
  return new BffToolError(code, message, reason, RETRYABLE_CODES.has(code), envelope.error?.details);
}

function assertContractVersion(data: Record<string, unknown>, expected: string | null): void {
  if (!expected) return;
  const actual = data.contractVersion;
  if (typeof actual === "string" && actual !== expected) {
    throw new BffToolError(
      "BAD_REQUEST",
      `Contract version mismatch: expected ${expected}, got ${actual}`,
      "contract_version_mismatch",
      false,
    );
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
