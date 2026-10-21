import {
  buildTpayTransactionPayload,
  type TpayPaymentError,
  type TpayTransactionCreateInput,
  type TpayTransactionCreated,
} from "./tpayTransactionPayload.js";
import { tpayTransactionDispatchBoundary } from "./tpayDispatchFailure.js";
import { readTpayHttpFailure, TpayHttpError } from "./tpayHttpFailure.js";

export { TpayHttpError } from "./tpayHttpFailure.js";

export interface TpayFetchLike {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface TpayHttpClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetchImpl?: TpayFetchLike;
  now?: () => number;
}

export type {
  TpayAliasInput,
  TpayPayerInput,
  TpayPaymentError,
  TpayTransactionCreateInput,
  TpayTransactionCreated,
} from "./tpayTransactionPayload.js";

export interface TpayPaymentChannel {
  id: string;
  name: string;
  fullName: string;
  available: boolean;
  onlinePayment: boolean;
  instantRedirection: boolean;
  groups: Array<{ id: number; name: string }>;
}

export interface TpayHttpClient {
  createTransaction(input: TpayTransactionCreateInput): Promise<TpayTransactionCreated>;
  getTransaction(transactionId: string): Promise<TpayTransactionReadback>;
  listPaymentChannels(): Promise<TpayPaymentChannel[]>;
}

export interface TpayTransactionReadback extends Record<string, unknown> {
  transactionId: string;
  title: string | null;
  status: string;
  transactionPaymentUrl: string | null;
  amount: number | null;
  currency: string | null;
  requestId: string | null;
  payments: Record<string, unknown>;
}

interface OAuthToken {
  accessToken: string;
  expiresAtMs: number;
}

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TPAY_TIMEOUT_MS = 10_000;

export function createTpayHttpClient({
  baseUrl,
  clientId,
  clientSecret,
  timeoutMs = DEFAULT_TPAY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch as unknown as TpayFetchLike,
  now = () => Date.now(),
}: TpayHttpClientOptions): TpayHttpClient {
  let token: OAuthToken | null = null;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  function requestDeadline(): { expiresAtMs: number } {
    return { expiresAtMs: Date.now() + timeoutMs };
  }

  async function bearer(deadline: { expiresAtMs: number }): Promise<string> {
    if (token && token.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now()) {
      return token.accessToken;
    }
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
    const response = await fetchWithTimeout(fetchImpl, `${normalizedBaseUrl}/oauth/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, remainingTimeoutMs(deadline, "tpay_oauth_timeout"), "tpay_oauth_timeout");
    const json = await readJson(response, "tpay_oauth_failed");
    const accessToken = readString(json, "access_token");
    const expiresIn = readNumber(json, "expires_in");
    token = { accessToken, expiresAtMs: now() + expiresIn * 1000 };
    return accessToken;
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown } = {},
    deadline = requestDeadline(),
  ) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await bearer(deadline)}` };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const response = await fetchWithTimeout(fetchImpl, `${normalizedBaseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    }, remainingTimeoutMs(deadline, "tpay_request_timeout"), "tpay_request_timeout");
    return readJson(response, "tpay_request_failed");
  }

  return {
    async createTransaction(input) {
      const deadline = requestDeadline();
      return tpayTransactionDispatchBoundary({
        authenticate: () => bearer(deadline),
        prepare: (accessToken) => ({
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildTpayTransactionPayload(input)),
          timeoutMs: remainingTimeoutMs(deadline, "tpay_request_deadline_exhausted"),
        }),
        dispatch: ({ headers, body, timeoutMs }) => fetchWithTimeout(
          fetchImpl,
          `${normalizedBaseUrl}/transactions`,
          { method: "POST", headers, body },
          timeoutMs,
          "tpay_request_timeout",
        ),
        decode: async (response) => {
          const json = await readJson(response, "tpay_request_failed");
          const payments = asRecord(json.payments);
          return {
            transactionId: readString(json, "transactionId"),
            title: readString(json, "title"),
            status: readString(json, "status"),
            transactionPaymentUrl: readNullableString(json, "transactionPaymentUrl"),
            requestId: readNullableString(json, "requestId"),
            payIdEligible: typeof payments.payIdEligible === "boolean" ? payments.payIdEligible : null,
            errors: readPaymentErrors(payments.errors),
          };
        },
      });
    },

    async getTransaction(transactionId) {
      const json = await request(
        `/transactions/${encodeURIComponent(transactionId)}`,
        {},
        requestDeadline(),
      );
      return {
        // Keep provider fields that recovery normalizes later (notably nested
        // dates and paidAmount). Explicit canonical fields below remain the
        // typed client contract.
        ...json,
        transactionId: readString(json, "transactionId"),
        title: readNullableString(json, "title"),
        status: readString(json, "status"),
        transactionPaymentUrl: readNullableString(json, "transactionPaymentUrl"),
        amount: readNullableTransactionAmount(json, "amount"),
        currency: readNullableString(json, "currency"),
        requestId: readNullableString(json, "requestId"),
        payments: asRecord(json.payments),
      };
    },

    async listPaymentChannels() {
      const json = await request("/transactions/channels", {}, requestDeadline());
      const channels: unknown[] = Array.isArray((json as Record<string, unknown>).channels)
        ? (json as Record<string, unknown>).channels as unknown[]
        : [];
      return channels.map(mapChannel);
    },
  };
}

function remainingTimeoutMs(deadline: { expiresAtMs: number }, timeoutCode: string): number {
  const remaining = deadline.expiresAtMs - Date.now();
  if (remaining <= 0) throw new TpayHttpError(timeoutCode, 504);
  return remaining;
}

async function fetchWithTimeout(
  fetchImpl: TpayFetchLike,
  url: string,
  init: Parameters<TpayFetchLike>[1],
  timeoutMs: number,
  timeoutCode: string,
): ReturnType<TpayFetchLike> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TpayHttpError(timeoutCode, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readPaymentErrors(value: unknown): TpayPaymentError[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      errorCode: String(record.errorCode ?? ""),
      errorMessage: String(record.errorMessage ?? ""),
      fieldName: typeof record.fieldName === "string" ? record.fieldName : null,
    };
  });
}

async function readJson(response: Awaited<ReturnType<TpayFetchLike>>, code: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const failure = await readTpayHttpFailure(response);
    throw new TpayHttpError(code, response.status, failure.diagnostic, failure.refusedBeforeTransaction);
  }
  const json = await response.json();
  if (!json || typeof json !== "object") throw new TpayHttpError("tpay_invalid_response", response.status);
  return json as Record<string, unknown>;
}

function mapChannel(value: unknown): TpayPaymentChannel {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    id: String(record.id ?? ""),
    name: String(record.name ?? ""),
    fullName: String(record.fullName ?? record.name ?? ""),
    available: record.available === true,
    onlinePayment: record.onlinePayment === true,
    instantRedirection: record.instantRedirection === true,
    groups: Array.isArray(record.groups) ? record.groups.map(mapGroup) : [],
  };
}

function mapGroup(value: unknown): { id: number; name: string } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { id: Number(record.id ?? 0), name: String(record.name ?? "") };
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new TpayHttpError("tpay_invalid_response", 200);
  return raw;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new TpayHttpError("tpay_invalid_response", 200);
  return raw;
}

function readNullableTransactionAmount(value: Record<string, unknown>, key: string): number | null {
  const raw = value[key];
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
