import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_HEADER_BYTES = 64 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;
const CAPABILITY_HEADER = "authorization";
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"] as const);

export type OrderReviewMediaMime = "image/jpeg" | "image/png" | "image/webp";

export interface OrderReviewRawUploadSession {
  upload(input: { body: AsyncIterable<Uint8Array>; signal: AbortSignal }): Promise<OrderReviewRawUploadResult>;
}

export interface OrderReviewRawUploadBinding {
  admit(input: { capabilityDigest: string; declaredMime: OrderReviewMediaMime; declaredBytes: number }):
    Promise<OrderReviewRawUploadSession | OrderReviewRawUploadResult>;
}

export type OrderReviewRawUploadResult =
  | { kind: "complete"; status: 200 | 201; mediaRef: string }
  | { kind: "refused"; status: 404 | 409 | 413 | 415 | 503; code: string };

export type OrderReviewRawUploadBindingState =
  | { kind: "direct"; binding: OrderReviewRawUploadBinding }
  | { kind: "hosted" }
  | { kind: "unbound" };

export function createOrderReviewRawUploadHandler(options: { resolveBinding: () => OrderReviewRawUploadBindingState
  | Promise<OrderReviewRawUploadBindingState>; timeoutMs?: number }) {
  return async function orderReviewRawUpload(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "PUT") return sendError(res, 405, "METHOD_NOT_ALLOWED");
    let state: OrderReviewRawUploadBindingState;
    try {
      state = await options.resolveBinding();
    } catch {
      return sendError(res, 503, "ORDER_REVIEW_MEDIA_UNAVAILABLE");
    }
    if (state.kind === "hosted") return sendError(res, 405, "METHOD_NOT_ALLOWED");
    if (state.kind === "unbound") return sendError(res, 503, "ORDER_REVIEW_MEDIA_UNAVAILABLE");
    let headers: ValidatedHeaders;
    try {
      headers = validateHeaders(req);
    } catch (error) {
      const input = asInputError(error);
      return sendError(res, input.status, input.code);
    }

    let admission: OrderReviewRawUploadSession | OrderReviewRawUploadResult;
    try {
      admission = await state.binding.admit({
        capabilityDigest: headers.capabilityDigest,
        declaredMime: headers.mime,
        declaredBytes: headers.bytes,
      });
    } catch {
      return sendError(res, 503, "ORDER_REVIEW_MEDIA_UNAVAILABLE");
    }
    if (isResult(admission)) { if (admission.kind === "refused") req.resume(); return sendResult(res, admission); }

    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort(new Error("raw upload deadline exceeded"));
      req.destroy();
    }, options.timeoutMs ?? 30_000);
    timeout.unref?.();
    const onAborted = () => abort.abort(new Error("raw upload aborted"));
    req.once("aborted", onAborted);
    try {
      const result = await admission.upload({
        body: validatedImageBody(req, headers.mime, headers.bytes, abort.signal),
        signal: abort.signal,
      });
      return sendResult(res, result);
    } catch (error) {
      if (error instanceof InputError) return sendError(res, error.status, error.code);
      if (abort.signal.aborted) return sendError(res, 400, "UPLOAD_ABORTED");
      return sendError(res, 503, "ORDER_REVIEW_MEDIA_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      req.off("aborted", onAborted);
    }
  };
}

interface ValidatedHeaders {
  capabilityDigest: string;
  mime: OrderReviewMediaMime;
  bytes: number;
}

function validateHeaders(req: HttpRequest): ValidatedHeaders {
  if (headerValues(req, "transfer-encoding").length > 0) fail(400, "TRANSFER_ENCODING_REFUSED");
  if (headerValues(req, "content-encoding").length > 0) fail(400, "CONTENT_ENCODING_REFUSED");
  if (headerValues(req, "range").length > 0) fail(400, "RANGE_REFUSED");

  const lengths = headerValues(req, "content-length");
  if (lengths.length !== 1 || !/^[1-9][0-9]*$/.test(lengths[0]!) || lengths[0]!.includes(",")) {
    fail(400, "INVALID_CONTENT_LENGTH");
  }
  const bytes = Number(lengths[0]);
  if (!Number.isSafeInteger(bytes)) fail(400, "INVALID_CONTENT_LENGTH");
  if (bytes > MAX_UPLOAD_BYTES) fail(413, "UPLOAD_TOO_LARGE");

  const contentTypes = headerValues(req, "content-type");
  if (contentTypes.length !== 1 || contentTypes[0]!.includes(";") || contentTypes[0]!.includes(",")) {
    fail(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const mime = contentTypes[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime as OrderReviewMediaMime)) fail(415, "UNSUPPORTED_MEDIA_TYPE");

  const authorizations = headerValues(req, CAPABILITY_HEADER);
  if (authorizations.length !== 1) fail(404, "ORDER_REVIEW_MEDIA_NOT_FOUND");
  const match = /^Bearer (order-review-upload:[a-f0-9-]{36})$/.exec(authorizations[0]!);
  if (!match) fail(404, "ORDER_REVIEW_MEDIA_NOT_FOUND");
  const capabilityDigest = createHash("sha256").update(match[1]!, "utf8").digest("hex");
  return { capabilityDigest, mime: mime as OrderReviewMediaMime, bytes };
}

function headerValues(req: HttpRequest, name: string): string[] {
  const values: string[] = [];
  const raw = req.rawHeaders ?? [];
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) values.push(raw[index + 1] ?? "");
  }
  if (values.length > 0) return values;
  const fallback = req.headers[name];
  if (fallback === undefined) return [];
  return Array.isArray(fallback) ? fallback : [String(fallback)];
}

async function* validatedImageBody(
  source: AsyncIterable<unknown>,
  mime: OrderReviewMediaMime,
  declaredBytes: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const header = Buffer.alloc(MAX_IMAGE_HEADER_BYTES);
  const pending: Uint8Array[] = [];
  let headerBytes = 0;
  let seen = 0;
  let accepted = false;
  for await (const value of source) {
    if (signal.aborted) fail(400, "UPLOAD_ABORTED");
    const chunk = toBytes(value);
    seen += chunk.byteLength;
    if (seen > declaredBytes || seen > MAX_UPLOAD_BYTES) fail(413, "UPLOAD_TOO_LARGE");
    if (!accepted) {
      pending.push(chunk);
      const copyBytes = Math.min(chunk.byteLength, header.byteLength - headerBytes);
      if (copyBytes > 0) {
        header.set(chunk.subarray(0, copyBytes), headerBytes);
        headerBytes += copyBytes;
      }
      const dimensions = inspectImageHeader(mime, header.subarray(0, headerBytes), declaredBytes);
      if (dimensions) {
        assertDimensions(dimensions.width, dimensions.height);
        accepted = true;
        for (const buffered of pending) yield buffered;
        pending.length = 0;
      } else if (headerBytes === MAX_IMAGE_HEADER_BYTES) {
        fail(415, "INVALID_IMAGE");
      }
    } else {
      yield chunk;
    }
  }
  if (signal.aborted) fail(400, "UPLOAD_ABORTED");
  if (seen !== declaredBytes) fail(400, "CONTENT_LENGTH_MISMATCH");
  if (!accepted) fail(415, "INVALID_IMAGE");
}

export function inspectImageHeader(mime: OrderReviewMediaMime, bytes: Uint8Array, declaredBytes: number):
  { width: number; height: number } | null {
  if (mime === "image/png") {
    if (bytes.length < 33) {
      if (bytes.length === declaredBytes) fail(415, "INVALID_IMAGE");
      return null;
    }
    if (!matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) || readU32BE(bytes, 8) !== 13
      || ascii(bytes, 12, 4) !== "IHDR" || declaredBytes < 57 || crc32(bytes.subarray(12, 29)) !== readU32BE(bytes, 29)) {
      fail(415, "INVALID_IMAGE");
    }
    const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!depths[bytes[25]!]?.includes(bytes[24]!) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) fail(415, "INVALID_IMAGE");
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
  }
  if (mime === "image/webp") return inspectWebp(bytes, declaredBytes);
  return inspectJpeg(bytes);
}

function inspectWebp(bytes: Uint8Array, declaredBytes: number) {
  if (bytes.length < 16) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") fail(415, "INVALID_IMAGE");
  if (readU32LE(bytes, 4) + 8 !== declaredBytes) fail(415, "INVALID_IMAGE");
  const kind = ascii(bytes, 12, 4);
  const chunkBytes = readU32LE(bytes, 16);
  if (kind === "VP8X") {
    if (bytes.length < 38) {
      if (bytes.length === declaredBytes) fail(415, "INVALID_IMAGE");
      return null;
    }
    if (chunkBytes !== 10 || !["VP8 ", "VP8L", "ALPH"].includes(ascii(bytes, 30, 4))) fail(415, "INVALID_IMAGE");
    return { width: 1 + readU24LE(bytes, 24), height: 1 + readU24LE(bytes, 27) };
  }
  if (kind === "VP8L") {
    if (bytes.length < 25) return null;
    if (bytes[20] !== 0x2f || chunkBytes < 6 || 20 + chunkBytes + (chunkBytes & 1) !== declaredBytes) fail(415, "INVALID_IMAGE");
    return {
      width: 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!),
      height: 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | ((bytes[22]! & 0xc0) >> 6)),
    };
  }
  if (kind === "VP8 ") {
    if (bytes.length < 30) return null;
    if (!matches(bytes, 23, [0x9d, 0x01, 0x2a]) || chunkBytes < 10
      || 20 + chunkBytes + (chunkBytes & 1) !== declaredBytes) fail(415, "INVALID_IMAGE");
    return { width: readU16LE(bytes, 26) & 0x3fff, height: readU16LE(bytes, 28) & 0x3fff };
  }
  fail(415, "INVALID_IMAGE");
}

function inspectJpeg(bytes: Uint8Array) {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) fail(415, "INVALID_IMAGE");
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) fail(415, "INVALID_IMAGE");
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) fail(415, "INVALID_IMAGE");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2) fail(415, "INVALID_IMAGE");
    if (isStartOfFrame(marker)) {
      if (length < 11) fail(415, "INVALID_IMAGE");
      if (offset + length > bytes.length) return null;
      const components = bytes[offset + 7]!;
      if (bytes[offset + 2] !== 8 || components < 1 || components > 4 || length !== 8 + 3 * components) fail(415, "INVALID_IMAGE");
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    if (offset + length > bytes.length) return null;
    offset += length;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function assertDimensions(width: number, height: number): void {
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    fail(415, "INVALID_IMAGE_DIMENSIONS");
  }
}

function toBytes(value: unknown): Uint8Array {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return value;
  fail(400, "INVALID_BODY_CHUNK");
}

class InputError extends Error {
  constructor(readonly status: 400 | 404 | 413 | 415, readonly code: string) { super(code); }
}

function fail(status: 400 | 404 | 413 | 415, code: string): never { throw new InputError(status, code); }
function asInputError(error: unknown): InputError {
  return error instanceof InputError ? error : new InputError(400, "INVALID_UPLOAD_BODY");
}
function isResult(value: OrderReviewRawUploadSession | OrderReviewRawUploadResult): value is OrderReviewRawUploadResult {
  return "kind" in value;
}
function sendResult(res: HttpResponse, result: OrderReviewRawUploadResult): void {
  if (result.kind === "complete") {
    res.status(result.status).json({ data: { mediaRef: result.mediaRef } });
  } else sendError(res, result.status, result.code);
}
function sendError(res: HttpResponse, status: number, code: string): void {
  res.status(status).json({ error: { code, message: "Order review media request refused" } });
}
function matches(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function readU16LE(bytes: Uint8Array, offset: number): number { return bytes[offset]! | (bytes[offset + 1]! << 8); }
function readU24LE(bytes: Uint8Array, offset: number): number { return readU16LE(bytes, offset) | (bytes[offset + 2]! << 16); }
function readU32LE(bytes: Uint8Array, offset: number): number { return (readU16LE(bytes, offset) | (readU16LE(bytes, offset + 2) << 16)) >>> 0; }
function readU32BE(bytes: Uint8Array, offset: number): number { return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0; }
