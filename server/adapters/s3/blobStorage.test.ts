import { describe, expect, it } from "vitest";
import {
  createS3BlobStorage,
  type S3ObjectClient,
} from "./blobStorage.js";
import { runBlobPortContract } from "../blobPortContract.testFixtures.js";

// In-memory S3-compatible fake matching the structural client the adapter depends on.
function makeFakeS3(): S3ObjectClient {
  const objects = new Map<string, Uint8Array>();
  return {
    putObject(input) {
      objects.set(input.Key, input.Body);
      return Promise.resolve({});
    },
    headObject(input) {
      if (!objects.has(input.Key)) return Promise.reject(new Error("NotFound"));
      return Promise.resolve({});
    },
    deleteObject(input) {
      objects.delete(input.Key);
      return Promise.resolve({});
    },
    listObjectsV2(input) {
      const Contents = [...objects.keys()]
        .filter((key) => !input.Prefix || key.startsWith(input.Prefix))
        .map((Key) => ({ Key }));
      return Promise.resolve({ Contents });
    },
  };
}

const BASE = "https://cdn.example.com";

describe("s3 blob storage", () => {
  runBlobPortContract("s3", () =>
    createS3BlobStorage(makeFakeS3(), { bucket: "openlup-blobs", baseUrl: BASE }),
  );

  it("urlFor builds a base-url public link", () => {
    const blob = createS3BlobStorage(makeFakeS3(), { bucket: "openlup-blobs", baseUrl: `${BASE}/` });
    expect(blob.urlFor("pet/x.png")).toBe(`${BASE}/pet/x.png`);
  });

  it("upload passes bucket/key/content-type to putObject", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: S3ObjectClient = {
      ...makeFakeS3(),
      putObject(input) {
        calls.push(input);
        return Promise.resolve({});
      },
    };
    const blob = createS3BlobStorage(client, { bucket: "openlup-blobs", baseUrl: BASE });
    await blob.upload("pet/x.png", Buffer.from("x"), { contentType: "image/png" });
    expect(calls[0]).toMatchObject({
      Bucket: "openlup-blobs",
      Key: "pet/x.png",
      ContentType: "image/png",
    });
  });

  it("exists returns false when headObject rejects", async () => {
    const blob = createS3BlobStorage(makeFakeS3(), { bucket: "openlup-blobs", baseUrl: BASE });
    expect(await blob.exists("pet/missing.png")).toBe(false);
  });

  it("delete strips a full public url to the object key", async () => {
    const client = makeFakeS3();
    const blob = createS3BlobStorage(client, { bucket: "openlup-blobs", baseUrl: BASE });
    await blob.upload("pet/del.png", Buffer.from("d"));
    await blob.delete(`${BASE}/pet/del.png`);
    expect(await blob.exists("pet/del.png")).toBe(false);
  });
});
