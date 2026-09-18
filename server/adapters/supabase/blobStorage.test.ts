import { describe, expect, it } from "vitest";
import {
  createSupabaseBlobStorage,
  type SupabaseStorageClient,
} from "./blobStorage.js";
import { runBlobPortContract } from "../blobPortContract.testFixtures.js";

const PUBLIC_PREFIX = "https://proj.supabase.co/storage/v1/object/public";

// Minimal in-memory Supabase Storage fake matching the bucket API surface the adapter uses.
function makeFakeClient(bucket: string): SupabaseStorageClient {
  const files = new Map<string, Uint8Array>();
  return {
    storage: {
      from(b: string) {
        expect(b).toBe(bucket);
        return {
          upload(path: string, bytes: Uint8Array, _opts) {
            files.set(path, bytes);
            return Promise.resolve({ data: { path }, error: null });
          },
          remove(paths: string[]) {
            for (const p of paths) files.delete(p);
            return Promise.resolve({ data: {}, error: null });
          },
          list(prefix?: string) {
            const base = prefix ? `${prefix.replace(/\/$/, "")}/` : "";
            const names = [...files.keys()]
              .filter((key) => key.startsWith(base))
              .map((key) => key.slice(base.length))
              .filter((leaf) => !leaf.includes("/"));
            return Promise.resolve({ data: names.map((name) => ({ name })), error: null });
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `${PUBLIC_PREFIX}/${bucket}/${path}` } };
          },
        };
      },
    },
  };
}

describe("supabase blob storage", () => {
  runBlobPortContract("supabase", () => createSupabaseBlobStorage(makeFakeClient("media"), "media"));

  it("upload uses upsert and returns the public url", async () => {
    const blob = createSupabaseBlobStorage(makeFakeClient("dhl-labels"), "dhl-labels", {
      defaultContentType: "application/pdf",
    });
    const result = await blob.upload("TRACK123.pdf", Buffer.from("%PDF"));
    expect(result.url).toBe(`${PUBLIC_PREFIX}/dhl-labels/TRACK123.pdf`);
    expect(result.pathname).toBe("TRACK123.pdf");
  });

  it("upload throws a sanitized error when the bucket returns an error", async () => {
    const client: SupabaseStorageClient = {
      storage: {
        from() {
          return {
            upload: () => Promise.resolve({ data: null, error: { message: "boom" } }),
            remove: () => Promise.resolve({ data: null, error: null }),
            list: () => Promise.resolve({ data: [], error: null }),
            getPublicUrl: (p: string) => ({ data: { publicUrl: p } }),
          };
        },
      },
    };
    const blob = createSupabaseBlobStorage(client, "media");
    await expect(blob.upload("x.png", Buffer.from("x"))).rejects.toThrow(/upload_failed:boom/);
  });

  it("delete strips a full public url down to the bucket key", async () => {
    const client = makeFakeClient("media");
    const blob = createSupabaseBlobStorage(client, "media");
    await blob.upload("folder/file.png", Buffer.from("data"));
    await blob.delete(`${PUBLIC_PREFIX}/media/folder/file.png`);
    expect(await blob.exists("folder/file.png")).toBe(false);
  });
});
