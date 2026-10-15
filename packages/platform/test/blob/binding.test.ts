import { describe, expect, it, vi } from "vitest";
import { bindBlobPort } from "../../src/blob/binding.js";
import type { VercelBlobSdk } from "../../src/blob/vercel.js";

const vercelBlob: VercelBlobSdk = { put: vi.fn(), head: vi.fn(), del: vi.fn(), list: vi.fn() };
import type { S3ObjectClient } from "../../src/blob/s3.js";

describe("bindBlobPort", () => {
  it("leaves vercel-blob unbound without its injected SDK", () => {
    expect(bindBlobPort("vercel-blob", {})).toBeNull();
  });

  it("binds the vercel adapter for vercel-blob", () => {
    const port = bindBlobPort("vercel-blob", {}, { vercelBlob });
    expect(port).not.toBeNull();
    // urlFor needs a token; without one it throws — proves it is the vercel adapter.
    expect(() => port!.urlFor("k")).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it("binds the filesystem adapter only when root + base url are set", () => {
    expect(bindBlobPort("filesystem", {})).toBeNull();
    const port = bindBlobPort("filesystem", {
      BLOB_FS_ROOT: "/tmp/blobs",
      BLOB_FS_BASE_URL: "https://files.example.com",
    });
    expect(port).not.toBeNull();
    expect(port!.urlFor("a.png")).toBe("https://files.example.com/a.png");
  });

  it("binds s3 only with a client factory + bucket + base url", () => {
    const factory = (): S3ObjectClient => ({
      putObject: () => Promise.resolve({}),
      headObject: () => Promise.resolve({}),
      deleteObject: () => Promise.resolve({}),
      listObjectsV2: () => Promise.resolve({ Contents: [] }),
    });
    expect(bindBlobPort("s3", { BLOB_S3_BUCKET: "b", BLOB_S3_BASE_URL: "https://cdn" })).toBeNull();
    const port = bindBlobPort(
      "s3",
      { BLOB_S3_BUCKET: "b", BLOB_S3_BASE_URL: "https://cdn" },
      { s3ClientFactory: factory },
    );
    expect(port).not.toBeNull();
  });

  it("returns null for supabase (bound at the storage call-site) and unknown kinds", () => {
    expect(bindBlobPort("supabase", {})).toBeNull();
    expect(bindBlobPort("nonsense", {})).toBeNull();
  });
});
