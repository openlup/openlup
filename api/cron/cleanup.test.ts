import { beforeEach, describe, expect, it, vi } from "vitest";

const listDetailed = vi.fn<(prefix?: string) => Promise<unknown>>();
const del = vi.fn<(url: string) => Promise<void>>();
const record = vi.fn<(event: unknown) => Promise<void>>(() => Promise.resolve());

vi.mock("../../server/_lib/facades/blob.facade.js", () => ({
  blobFacade: {
    listDetailed: (prefix?: string) => listDetailed(prefix),
    delete: (url: string) => del(url),
  },
}));
vi.mock("../../server/_lib/facades/eventsLogger.facade.js", () => ({
  eventsLogger: { record: (event: unknown) => record(event) },
}));

import handler from "./cleanup.js";

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function makeReq(authorization?: string) {
  return { headers: authorization ? { authorization } : {} } as never;
}

describe("cron/cleanup", () => {
  beforeEach(() => {
    listDetailed.mockReset();
    del.mockReset();
    record.mockClear();
    process.env.CRON_SECRET = "topsecret";
  });

  it("fails closed (503) when CRON_SECRET is unset and never lists blobs", async () => {
    delete process.env.CRON_SECRET;
    const res = makeRes();
    await handler(makeReq("Bearer x"), res as never);
    expect(res.statusCode).toBe(503);
    expect(listDetailed).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized caller with 401", async () => {
    const res = makeRes();
    await handler(makeReq("Bearer wrong"), res as never);
    expect(res.statusCode).toBe(401);
    expect(listDetailed).not.toHaveBeenCalled();
  });

  it("deletes only blobs older than the TTL via listDetailed uploadedAt", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const fresh = new Date();
    listDetailed.mockResolvedValue({
      blobs: [
        { url: "https://cdn/old.png", pathname: "old.png", uploadedAt: old },
        { url: "https://cdn/fresh.png", pathname: "fresh.png", uploadedAt: fresh },
      ],
    });
    del.mockResolvedValue(undefined);
    const res = makeRes();
    await handler(makeReq("Bearer topsecret"), res as never);
    expect(res.statusCode).toBe(200);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("https://cdn/old.png");
    expect(res.body).toMatchObject({ ok: true, scanned: 2, deleted: 1 });
  });

  it("returns 500 when listing fails", async () => {
    listDetailed.mockRejectedValue(new Error("boom"));
    const res = makeRes();
    await handler(makeReq("Bearer topsecret"), res as never);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "list_failed" });
  });
});
