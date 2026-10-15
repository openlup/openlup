import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  adaptRequest, decorateRequest, decorateResponse, isRawStreamEntrypoint, isWebhookPath,
  NodeRequestAbortedError, NodeRequestBodyTooLargeError, pathnameOf,
} from "../../src/http/requestAdapter.js";
import type { HttpRequest } from "../../src/http/types.js";

function input(url = "/", body?: string, method = body === undefined ? "GET" : "POST") {
  const stream = new PassThrough();
  const req = Object.assign(stream, { url, method, headers: { host: "example.test" } }) as unknown as HttpRequest;
  stream.end(body);
  return req;
}

async function bytes(req: HttpRequest) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function output() {
  const headers = new Map<string, unknown>();
  const end = vi.fn();
  const raw = {
    statusCode: 200, end,
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  };
  return { res: decorateResponse(raw as never), end };
}

describe("request classification", () => {
  it.each([
    ["/api/bff/events/webhooks/primary", true], ["/api/bff/webhooks/nested/event", true],
    ["/api/bff/status", false], ["/api/bff/webhooks", false], ["/webhooks-extra/event", false],
  ])("classifies the complete segment in %s", (path, expected) => {
    expect(isWebhookPath(path)).toBe(expected);
  });

  it("classifies only the built-in raw entrypoint", () => {
    expect(isRawStreamEntrypoint("/api/csp-report")).toBe(true);
    expect(isRawStreamEntrypoint("/api/upload")).toBe(false);
    expect(isRawStreamEntrypoint("/api/bff/status")).toBe(false);
  });

  it("extracts the target pathname independently of Host", () => {
    const req = input("/api/bff/status?mode=brief");
    req.headers.host = "invalid host:!";
    expect(pathnameOf(req)).toBe("/api/bff/status");
    delete req.url;
    expect(pathnameOf(req)).toBe("/");
  });
});

describe("adaptRequest", () => {
  it.each(["/api/bff/events/webhooks/primary", "/api/bff/integrations/events", "/api/bff/status"])(
    "preserves exact bytes alongside parsed JSON at %s", async (path) => {
      const raw = '{\n  "entry": "item-7",\n  "count": 42\n}\n';
      const req = input(path, raw);
      expect(await adaptRequest(req, path)).toBe(req);
      expect(req.body).toEqual({ entry: "item-7", count: 42 });
      expect(await bytes(req)).toEqual(Buffer.from(raw));
    },
  );

  it("parses repeated query values and decoded cookies", async () => {
    const req = input("/api/bff/status?tag=one&tag=two&mode=brief&empty=");
    req.headers.cookie = "session=sample%20value; mode=dark; ignored; =skip; token=a%3Db";
    await adaptRequest(req, "/api/bff/status");
    expect(req.query).toEqual({ tag: ["one", "two"], mode: "brief", empty: "" });
    expect(req.cookies).toEqual({ session: "sample value", mode: "dark", token: "a=b" });
  });

  it.each([
    ["", undefined], [" \n ", undefined], [' [1, 2] ', [1, 2]],
    [' {"broken": ', '{"broken":'], ["  plain text  ", "plain text"],
  ])("handles buffered text %j", async (body, expected) => {
    const req = await adaptRequest(input("/", body), "/");
    expect(req.body).toEqual(expected);
    expect(await bytes(req)).toEqual(Buffer.from(body));
  });

  it("parses JSON primitives when the content type requests JSON", async () => {
    const req = input("/", "false");
    req.headers["content-type"] = "application/json; charset=utf-8";
    expect((await adaptRequest(req, "/")).body).toBe(false);
  });

  it.each(["GET", "HEAD"])("does not buffer a %s body", async (method) => {
    const req = await adaptRequest(input("/", "ignored", method), "/");
    expect(req.body).toBeUndefined();
    expect(await bytes(req)).toEqual(Buffer.alloc(0));
  });

  it.each(["/api/csp-report", "/api/upload"])("leaves the live stream at %s intact", async (path) => {
    const req = input(path, "raw-stream-input");
    const iterator = req[Symbol.asyncIterator];
    const adapted = path === "/api/csp-report"
      ? await adaptRequest(req, path)
      : await adaptRequest(req, path, true, 1);
    expect(adapted.body).toBeUndefined();
    expect(adapted[Symbol.asyncIterator]).toBe(iterator);
    expect(await bytes(adapted)).toEqual(Buffer.from("raw-stream-input"));
  });

  it("allows an explicit buffered override of the built-in raw path", async () => {
    const req = await adaptRequest(input("/api/csp-report", '{"count":1}'), "/api/csp-report", false);
    expect(req.body).toEqual({ count: 1 });
  });

  it("accepts the exact byte limit and rejects a multichunk overflow", async () => {
    expect((await adaptRequest(input("/", "1234"), "/", false, 4)).body).toBe("1234");
    const stream = new PassThrough();
    const req = Object.assign(stream, { method: "POST", headers: {} }) as unknown as HttpRequest;
    const result = adaptRequest(req, "/", false, 4);
    const rejected = expect(result).rejects.toBeInstanceOf(NodeRequestBodyTooLargeError);
    stream.write("123");
    stream.end("45");
    await rejected;
    expect(req.listenerCount("data")).toBe(0);
  });

  it.each([true, false])("stops admission when aborted (already aborted: %s)", async (already) => {
    const req = Object.assign(new PassThrough(), { method: "POST", headers: {} }) as unknown as HttpRequest;
    const controller = new AbortController();
    req.abortSignal = controller.signal;
    if (already) controller.abort();
    const result = adaptRequest(req, "/");
    const rejected = expect(result).rejects.toBeInstanceOf(NodeRequestAbortedError);
    controller.abort();
    await rejected;
    expect(req.listenerCount("data")).toBe(0);
    req.destroy();
  });

  it("propagates stream errors and removes admission listeners", async () => {
    const req = Object.assign(new PassThrough(), { method: "POST", headers: {} }) as unknown as HttpRequest;
    const fault = new Error("input fault");
    const rejected = expect(adaptRequest(req, "/")).rejects.toBe(fault);
    req.emit("error", fault);
    await rejected;
    expect(req.listenerCount("data")).toBe(0);
    req.destroy();
  });
});

describe("response decoration", () => {
  it("chains status and JSON with a default content type", () => {
    const { res, end } = output();
    expect(res.status(201).json({ ok: true })).toBe(res);
    expect(res.statusCode).toBe(201);
    expect(res.getHeader("content-type")).toBe("application/json; charset=utf-8");
    expect(end).toHaveBeenCalledExactlyOnceWith('{"ok":true}');
  });

  it.each(["text", Buffer.from("bytes"), { count: 3 }])("sends %j without changing its representation", (body) => {
    const { res, end } = output();
    expect(res.send(body)).toBe(res);
    expect(end).toHaveBeenCalledExactlyOnceWith(typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
    expect(res.getHeader("content-type")).toBe(Buffer.isBuffer(body) || typeof body === "string" ? undefined : "application/json; charset=utf-8");
  });

  it.each(["json", "send"] as const)("keeps an existing content type for %s", (method) => {
    const { res } = output();
    res.setHeader("Content-Type", "application/example+json");
    res[method]({ count: 2 });
    expect(res.getHeader("content-type")).toBe("application/example+json");
  });

  it("supports default and explicit redirect status codes", () => {
    for (const code of [302, 308]) {
      const { res, end } = output();
      expect(code === 302 ? res.redirect("/target") : res.redirect(code, "/target")).toBe(res);
      expect(res.statusCode).toBe(code);
      expect(res.getHeader("location")).toBe("/target");
      expect(end).toHaveBeenCalledExactlyOnceWith();
    }
  });
});

describe("request decoration", () => {
  it("initializes query and preserves an existing query object", () => {
    const req = input();
    expect(decorateRequest(req)).toBe(req);
    expect(req.query).toEqual({});
    const query = { page: "2" };
    req.query = query;
    expect(decorateRequest(req).query).toBe(query);
  });
});
