import {
  orderReviewGrantReferenceSchema,
  orderReviewMediaIntentResultSchema,
  orderReviewMediaSchema,
  orderReviewReadResultSchema,
  orderReviewSchema,
  type OrderReview,
  type OrderReviewMedia,
  type OrderReviewMediaIntentResult,
} from "./orderReviewContracts.js";

type LocationSource = Pick<Location, "hash" | "pathname" | "search">;
type HistorySink = Pick<History, "replaceState" | "state">;
type Fetcher = typeof fetch;

export interface PreparedOrderReviewMedia {
  readonly file: Blob;
  readonly uploadCapability: string;
  readonly capabilityDigest: string;
  readonly fileDigest: string;
  readonly intentCommandKey: string;
  readonly confirmCommandKey: string;
}

let capturedGrant: string | null = null;

/** Capture the URL capability once, then remove every fragment from the two entry paths. */
export function captureOrderReviewGrantFromLocation(
  location: LocationSource,
  history: HistorySink,
): string | null {
  if (location.pathname !== "/review" && location.pathname !== "/recenzja") return capturedGrant;
  const candidate = location.hash.startsWith("#grant=")
    ? location.hash.slice("#grant=".length)
    : "";
  const parsed = orderReviewGrantReferenceSchema.safeParse(candidate);
  capturedGrant = parsed.success ? parsed.data : null;
  if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return capturedGrant;
}

export function readOrderReviewGrant(): string | null {
  return capturedGrant;
}

export function requireOrderReviewGrant(): string {
  if (!capturedGrant) throw new Error("order_review_unavailable");
  return capturedGrant;
}

export async function readOrderReview(options: { fetcher?: Fetcher; signal?: AbortSignal } = {}): Promise<OrderReview | null> {
  const data = await requestJson("/api/bff/order-review", {
    method: "GET",
    signal: options.signal,
  }, options.fetcher);
  return orderReviewReadResultSchema.parse(data).review;
}

export async function submitOrderReview(
  rating: number,
  comment: string,
  options: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<OrderReview> {
  const normalized = comment.trim();
  const fingerprint = await sha256(new TextEncoder().encode(`${rating}\n${normalized}`));
  const data = await requestJson("/api/bff/order-review", {
    method: "POST",
    body: JSON.stringify({ kind: "submit", input: {
      rating,
      ...(normalized ? { comment: normalized } : {}),
      fingerprint,
    } }),
    signal: options.signal,
  }, options.fetcher);
  return orderReviewSchema.parse(asRecord(data).review);
}

/** Mint once per selected file. Callers retain this object unchanged for retries. */
export async function prepareOrderReviewMedia(
  file: Blob,
  cryptoSource: Pick<Crypto, "randomUUID" | "subtle"> = crypto,
): Promise<PreparedOrderReviewMedia> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size < 1 || file.size > 20 * 1024 * 1024) {
    throw new Error("order_review_media_invalid");
  }
  const uploadCapability = `order-review-upload:${cryptoSource.randomUUID()}`;
  const [capabilityDigest, fileDigest] = await Promise.all([
    digestWith(cryptoSource.subtle, new TextEncoder().encode(uploadCapability)),
    digestWith(cryptoSource.subtle, new Uint8Array(await file.arrayBuffer())),
  ]);
  return {
    file,
    uploadCapability,
    capabilityDigest,
    fileDigest,
    intentCommandKey: `intent:${cryptoSource.randomUUID()}`,
    confirmCommandKey: `confirm:${cryptoSource.randomUUID()}`,
  };
}

export async function createOrderReviewMediaIntent(
  prepared: PreparedOrderReviewMedia,
  options: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<OrderReviewMediaIntentResult> {
  const data = await requestJson("/api/bff/order-review", {
    method: "POST",
    body: JSON.stringify({ kind: "media_intent", input: {
      contentType: prepared.file.type,
      byteLength: prepared.file.size,
      capabilityDigest: prepared.capabilityDigest,
      commandKey: prepared.intentCommandKey,
    } }),
    signal: options.signal,
  }, options.fetcher);
  return orderReviewMediaIntentResultSchema.parse(asRecord(data).result);
}

export async function confirmOrderReviewMedia(
  mediaRef: string,
  prepared: PreparedOrderReviewMedia,
  options: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<OrderReviewMedia> {
  const data = await requestJson("/api/bff/order-review", {
    method: "POST",
    body: JSON.stringify({ kind: "media_confirm", input: {
      mediaRef,
      digest: prepared.fileDigest,
      commandKey: prepared.confirmCommandKey,
    } }),
    signal: options.signal,
  }, options.fetcher);
  return orderReviewMediaSchema.parse(asRecord(data).media);
}

export async function uploadOrderReviewMedia(
  capability: string,
  file: Blob,
  options: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<void> {
  const response = await (options.fetcher ?? fetch)("/api/feedback-event", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${capability}`,
      "Content-Type": file.type,
    },
    body: file,
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`order_review_upload_${response.status}`);
}

export async function fetchOrderReviewMedia(
  mediaRef: string,
  options: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<Blob> {
  const response = await (options.fetcher ?? fetch)(
    `/api/bff/order-review/media/${encodeURIComponent(mediaRef)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${requireOrderReviewGrant()}` },
      signal: options.signal,
    },
  );
  if (!response.ok) throw new Error(`order_review_media_${response.status}`);
  return response.blob();
}

export function resetOrderReviewClientStateForTests(): void {
  capturedGrant = null;
}

async function requestJson(
  path: string,
  init: RequestInit,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireOrderReviewGrant()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`order_review_${response.status}`);
  const envelope = asRecord(await response.json());
  if (envelope.ok !== true) throw new Error("order_review_invalid_response");
  return envelope.data;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return digestWith(crypto.subtle, bytes);
}

async function digestWith(subtle: SubtleCrypto, bytes: Uint8Array): Promise<string> {
  const result = await subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(result)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("order_review_invalid_response");
  return value as Record<string, unknown>;
}
