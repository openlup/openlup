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

  it("binds s3 with the default client, or an injected factory, once bucket and base url are set", async () => {
    const putObject = vi.fn(() => Promise.resolve({}));
    const factory = vi.fn((): S3ObjectClient => ({
      putObject,
      headObject: () => Promise.resolve({}),
      deleteObject: () => Promise.resolve({}),
      listObjectsV2: () => Promise.resolve({ Contents: [] }),
    }));
    expect(bindBlobPort("s3", { BLOB_S3_BUCKET: "b" })).toBeNull();
    expect(bindBlobPort("s3", { BLOB_S3_BASE_URL: "https://cdn" })).toBeNull();
    // B4: the default client binds without an injected factory (the SDK loads on first use).
    expect(bindBlobPort("s3", { BLOB_S3_BUCKET: "b", BLOB_S3_BASE_URL: "https://cdn" })?.urlFor("k")).toBe("https://cdn/k");
    const env = { BLOB_S3_BUCKET: "b", BLOB_S3_BASE_URL: "https://cdn" };
    const port = bindBlobPort("s3", env, { s3ClientFactory: factory });
    await port!.upload("objects/a.txt", Buffer.from("a"));
    expect(factory).toHaveBeenCalledExactlyOnceWith(env);
    expect(putObject).toHaveBeenCalledWith(expect.objectContaining({ Bucket: "b", Key: "objects/a.txt" }));
  });

  it("binds supabase storage only with the injected client factory, data settings and bucket", async () => {
    const upload = vi.fn(async () => ({ data: {}, error: null }));
    const createSupabaseClient = vi.fn(() => ({
      storage: { from: vi.fn(() => ({ upload, remove: vi.fn(), list: vi.fn(), getPublicUrl: (path: string) => ({ data: { publicUrl: `https://data.example.test/${path}` } }) })) },
    }));
    const env = { SUPABASE_URL: "https://data.example.test", SUPABASE_SERVICE_ROLE_KEY: "service-key", BLOB_SUPABASE_BUCKET: "objects" };
    expect(bindBlobPort("supabase", env)).toBeNull();
    expect(bindBlobPort("supabase", { ...env, BLOB_SUPABASE_BUCKET: "" }, { createSupabaseClient })).toBeNull();
    expect(bindBlobPort("supabase", { ...env, SUPABASE_SERVICE_ROLE_KEY: undefined }, { createSupabaseClient })).toBeNull();
    const port = bindBlobPort("supabase", env, { createSupabaseClient });
    await port!.upload("a.txt", Buffer.from("a"));
    expect(createSupabaseClient).toHaveBeenCalledWith("https://data.example.test", "service-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(upload).toHaveBeenCalledOnce();
  });

  it("returns null for unknown kinds", () => {
    expect(bindBlobPort("nonsense", {})).toBeNull();
  });
});
