import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory @vercel/blob mock so the adapter's mapping logic is exercised without network/creds.
const store = new Map<string, { url: string; pathname: string; uploadedAt: Date }>();
const putSpy = vi.fn();
const delSpy = vi.fn();
const headSpy = vi.fn();
const listSpy = vi.fn();

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: Record<string, unknown>) => {
    putSpy(pathname, opts);
    const url = `https://store123.public.blob.vercel-storage.com/${pathname}`;
    const entry = { url, pathname, uploadedAt: new Date("2026-06-01T00:00:00Z") };
    store.set(pathname, entry);
    return Promise.resolve({ url, pathname });
  },
  del: (url: string) => {
    delSpy(url);
    for (const [key, entry] of store) if (entry.url === url || key === url) store.delete(key);
    return Promise.resolve();
  },
  head: (url: string) => {
    headSpy(url);
    const found = [...store.values()].find((entry) => entry.url === url);
    if (!found) return Promise.reject(new Error("not found"));
    return Promise.resolve({ url: found.url });
  },
  list: (opts: { prefix?: string } = {}) => {
    listSpy(opts);
    const blobs = [...store.values()].filter(
      (entry) => !opts.prefix || entry.pathname.startsWith(opts.prefix),
    );
    return Promise.resolve({ blobs });
  },
}));

import {
  createVercelBlobStorage,
  parseVercelStoreId,
} from "./blobStorage.js";
import { runBlobPortContract } from "../blobPortContract.testFixtures.js";

const TOKEN = "vercel_blob_rw_Store123_secretpart";

describe("vercel blob storage", () => {
  beforeEach(() => {
    store.clear();
    putSpy.mockClear();
    delSpy.mockClear();
    headSpy.mockClear();
    listSpy.mockClear();
  });

  runBlobPortContract("vercel", () => createVercelBlobStorage({ token: TOKEN }));

  it("parseVercelStoreId lowercases the store id and rejects bad tokens", () => {
    expect(parseVercelStoreId(TOKEN)).toBe("store123");
    expect(() => parseVercelStoreId(undefined)).toThrow(/missing/);
    expect(() => parseVercelStoreId("garbage")).toThrow(/invalid/);
  });

  it("urlFor builds the deterministic public CDN url from the token store id", () => {
    const blob = createVercelBlobStorage({ token: TOKEN });
    expect(blob.urlFor("pet-personalizer/abc.png")).toBe(
      "https://store123.public.blob.vercel-storage.com/pet-personalizer/abc.png",
    );
  });

  it("upload preserves the byte-identical put options", async () => {
    const blob = createVercelBlobStorage({ token: TOKEN, defaultContentType: "image/png" });
    await blob.upload("pet-personalizer/x.png", Buffer.from("png"));
    expect(putSpy).toHaveBeenCalledWith("pet-personalizer/x.png", {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
      cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
  });

  it("listDetailed surfaces uploadedAt for the TTL cron", async () => {
    const blob = createVercelBlobStorage({ token: TOKEN });
    await blob.upload("pet-personalizer/y.png", Buffer.from("y"));
    const { blobs } = await blob.listDetailed("pet-personalizer/");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.uploadedAt).toBeInstanceOf(Date);
  });

  it("exists swallows head() rejection as false", async () => {
    const blob = createVercelBlobStorage({ token: TOKEN });
    expect(await blob.exists("pet-personalizer/missing.png")).toBe(false);
  });
});
