import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import {
  createOrderReviewRawUploadHandler,
  inspectImageHeader,
  type OrderReviewRawUploadBinding,
  type OrderReviewRawUploadBindingState,
} from "./orderReviewRawUploadHandler.js";

const CAPABILITY = "Bearer order-review-upload:00000000-0000-4000-8000-000000000001";

function png(width = 2, height = 3): Buffer {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZMBgAoXkL9VMpiWIAAAAASUVORK5CYII=", "base64");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

function jpeg(): Buffer { return Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z", "base64"); }

function webp(): Buffer { return Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=", "base64"); }

function webpStub(width = 4, height = 5): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8X", 8, "ascii");
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

function request(body: Buffer, headers: Record<string, string | string[]> = {}): HttpRequest {
  const stream = new PassThrough();
  const req = stream as unknown as HttpRequest;
  req.method = "PUT";
  req.url = "/api/feedback-event";
  req.query = {};
  req.headers = {
    authorization: CAPABILITY,
    "content-type": "image/png",
    "content-length": String(body.byteLength),
    ...headers,
  };
  req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap((item) => [name, item ?? ""]),
  );
  stream.end(body);
  return req;
}

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function acceptingBinding(observed: Uint8Array[] = []): OrderReviewRawUploadBinding {
  return {
    admit: vi.fn(async () => ({
      upload: async ({ body }: { body: AsyncIterable<Uint8Array>; signal: AbortSignal }) => {
        for await (const chunk of body) observed.push(chunk);
        return { kind: "complete", status: 201, mediaRef: "media_ref_1" } as const;
      },
    })),
  };
}

function handler(state: OrderReviewRawUploadBindingState) {
  return createOrderReviewRawUploadHandler({ resolveBinding: () => state, timeoutMs: 1_000 });
}

describe("order-review raw upload handler", () => {
  it("admits one bearer and streams an exact valid PNG without CORS", async () => {
    const body = png();
    const observed: Uint8Array[] = [];
    const binding = acceptingBinding(observed);
    const res = response();
    await handler({ kind: "direct", binding })(request(body), res);

    expect(binding.admit).toHaveBeenCalledWith({
      capabilityDigest: createHash("sha256")
        .update("order-review-upload:00000000-0000-4000-8000-000000000001")
        .digest("hex"),
      declaredMime: "image/png",
      declaredBytes: body.byteLength,
    });
    expect(Buffer.concat(observed.map(Buffer.from))).toEqual(body);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ data: { mediaRef: "media_ref_1" } });
    expect((res.setHeader as ReturnType<typeof vi.fn> | undefined)?.mock?.calls ?? []).toEqual([]);
  });

  it("returns hosted 405 and direct-unbound 503 before parsing headers or body", async () => {
    const malformed = request(Buffer.from("not an image"), { authorization: "secret" });
    const hosted = response();
    await handler({ kind: "hosted" })(malformed, hosted);
    expect(hosted.status).toHaveBeenCalledWith(405);

    const unbound = response();
    await handler({ kind: "unbound" })(request(Buffer.alloc(0), {}), unbound);
    expect(unbound.status).toHaveBeenCalledWith(503);
  });

  it.each([
    ["missing length", { "content-length": [] }, 400, "INVALID_CONTENT_LENGTH"],
    ["duplicate length", { "content-length": ["24", "24"] }, 400, "INVALID_CONTENT_LENGTH"],
    ["comma length", { "content-length": "24,24" }, 400, "INVALID_CONTENT_LENGTH"],
    ["transfer encoding", { "transfer-encoding": "chunked" }, 400, "TRANSFER_ENCODING_REFUSED"],
    ["content encoding", { "content-encoding": "gzip" }, 400, "CONTENT_ENCODING_REFUSED"],
    ["range", { range: "bytes=0-1" }, 400, "RANGE_REFUSED"],
    ["multipart", { "content-type": "multipart/form-data; boundary=x" }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["duplicate auth", { authorization: [CAPABILITY, CAPABILITY] }, 404, "ORDER_REVIEW_MEDIA_NOT_FOUND"],
    ["query-shaped auth", { authorization: "Bearer bad/value" }, 404, "ORDER_REVIEW_MEDIA_NOT_FOUND"],
  ])("rejects %s before admission", async (_name, overrides, status, code) => {
    const binding = acceptingBinding();
    const res = response();
    await handler({ kind: "direct", binding })(request(png(), overrides as Record<string, string | string[]>), res);
    expect(binding.admit).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error: { code, message: "Order review media request refused" } });
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("order-review-upload");
  });

  it("maps admission refusal and safely drains the bounded request", async () => {
    const binding: OrderReviewRawUploadBinding = {
      admit: vi.fn(async () => ({ kind: "refused", status: 404, code: "ORDER_REVIEW_MEDIA_NOT_FOUND" } as const)),
    };
    const req = request(png());
    const res = response();
    await handler({ kind: "direct", binding })(req, res);
    expect(req.readableFlowing).toBe(true);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it.each([
    ["image/png", png(2, 3), { width: 2, height: 3 }],
    ["image/jpeg", jpeg(), { width: 2, height: 3 }],
    ["image/webp", webp(), { width: 2, height: 3 }],
  ] as const)("accepts bounded %s dimensions", (mime, body, dimensions) => {
    expect(inspectImageHeader(mime, body, body.byteLength)).toEqual(dimensions);
  });

  it.each([
    ["image/png", Buffer.alloc(24)],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0, 5, 0, 4])],
    ["image/webp", webpStub()],
  ] as const)("rejects a dimension-only %s header stub", (mime, body) => {
    expect(() => inspectImageHeader(mime, body, body.byteLength)).toThrow("INVALID_IMAGE");
  });

  it("refuses wrong magic, oversized dimensions, short streams and byte overruns", async () => {
    const cases: Array<{ body: Buffer; headers?: Record<string, string>; status: number; code: string }> = [
      { body: Buffer.alloc(24), status: 415, code: "INVALID_IMAGE" },
      { body: png(8192, 8192), status: 415, code: "INVALID_IMAGE_DIMENSIONS" },
      { body: png(8193, 1), status: 415, code: "INVALID_IMAGE_DIMENSIONS" },
      { body: png(), headers: { "content-length": String(20 * 1024 * 1024 + 1) }, status: 413, code: "UPLOAD_TOO_LARGE" },
      { body: png(), headers: { "content-length": "96" }, status: 400, code: "CONTENT_LENGTH_MISMATCH" },
      { body: png(), headers: { "content-length": "94" }, status: 413, code: "UPLOAD_TOO_LARGE" },
    ];
    for (const test of cases) {
      const res = response();
      await handler({ kind: "direct", binding: acceptingBinding() })(request(test.body, test.headers), res);
      expect(res.status, test.code).toHaveBeenCalledWith(test.status);
      expect(res.json, test.code).toHaveBeenCalledWith({ error: { code: test.code, message: "Order review media request refused" } });
    }
  });

  it("returns method refusal without binding access", async () => {
    const req = request(png());
    req.method = "POST";
    const resolveBinding = vi.fn(() => ({ kind: "unbound" }) as const);
    const res = response();
    await createOrderReviewRawUploadHandler({ resolveBinding })(req, res);
    expect(resolveBinding).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("fails closed when direct binding resolution throws", async () => {
    const res = response();
    await createOrderReviewRawUploadHandler({
      resolveBinding: () => { throw new Error("invalid direct configuration"); },
    })(request(png()), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "ORDER_REVIEW_MEDIA_UNAVAILABLE", message: "Order review media request refused" },
    });
  });
});
