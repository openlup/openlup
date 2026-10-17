import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ loads: 0, configs: [] as unknown[], sent: [] as Array<{ command: string; input: unknown }> }));
function fakeSdk() {
  sdk.loads += 1;
  const command = (name: string) => class { constructor(public readonly input: unknown) { (this as { name?: string }).name = name; } };
  return {
    S3Client: class {
      constructor(config: unknown) { sdk.configs.push(config); }
      async send(command: unknown) {
        const { name, input } = command as { name: string; input: unknown };
        sdk.sent.push({ command: name, input });
        return { Contents: [] };
      }
    },
    PutObjectCommand: command("put"),
    HeadObjectCommand: command("head"),
    DeleteObjectCommand: command("delete"),
    ListObjectsV2Command: command("list"),
  };
}

import { createS3ClientFromEnv } from "../../src/blob/s3Client.js";

describe("default S3 client", () => {
  it("creates no SDK client until the first call, then one client for every call", async () => {
    const client = createS3ClientFromEnv({
      BLOB_S3_REGION: "eu-central-1", BLOB_S3_ENDPOINT: "http://127.0.0.1:9000", BLOB_S3_FORCE_PATH_STYLE: "true",
      BLOB_S3_ACCESS_KEY_ID: "access", BLOB_S3_SECRET_ACCESS_KEY: "secret",
    }, fakeSdk);
    expect(sdk.loads).toBe(0);
    expect(sdk.configs).toHaveLength(0);
    await client.putObject({ Bucket: "b", Key: "k", Body: Buffer.from("x"), ContentType: "text/plain" });
    await client.headObject({ Bucket: "b", Key: "k" });
    await client.deleteObject({ Bucket: "b", Key: "k" });
    await client.listObjectsV2({ Bucket: "b", Prefix: "p" });
    expect(sdk.configs).toEqual([{
      region: "eu-central-1", endpoint: "http://127.0.0.1:9000", forcePathStyle: true,
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    }]);
    expect(sdk.sent.map(({ command }) => command)).toEqual(["put", "head", "delete", "list"]);
    expect(sdk.loads).toBe(1);
    expect(sdk.sent[0]!.input).toEqual({ Bucket: "b", Key: "k", Body: Buffer.from("x"), ContentType: "text/plain" });
  });

  it("defaults the region and leaves credentials to the SDK chain when none are set", async () => {
    sdk.configs.length = 0;
    await createS3ClientFromEnv({}, fakeSdk).headObject({ Bucket: "b", Key: "k" });
    expect(sdk.configs).toEqual([{ region: "us-east-1", endpoint: undefined, forcePathStyle: false, credentials: undefined }]);
  });

  it("refuses half a credential pair", () => {
    expect(() => createS3ClientFromEnv({ BLOB_S3_ACCESS_KEY_ID: "access" })).toThrow("blob_s3_credentials_incomplete");
    expect(() => createS3ClientFromEnv({ BLOB_S3_SECRET_ACCESS_KEY: "secret" })).toThrow("blob_s3_credentials_incomplete");
  });
});
