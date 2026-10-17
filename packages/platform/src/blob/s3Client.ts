// Default S3 client for the S3-compatible blob capability, built from the environment.
//
// `@aws-sdk/client-s3` is an optional peer: it is loaded on the first storage call, through Node's
// own module resolution, so an application that never selects S3 needs neither the SDK nor its
// settings. Settings:
// BLOB_S3_REGION (default us-east-1), BLOB_S3_ENDPOINT (an S3-compatible service; path-style
// addressing follows from BLOB_S3_FORCE_PATH_STYLE=true), and BLOB_S3_ACCESS_KEY_ID with
// BLOB_S3_SECRET_ACCESS_KEY (both, or neither to use the SDK's default credential chain).

import { createRequire } from "node:module";

import type { S3ObjectClient } from "./s3.js";

type Env = Record<string, string | undefined>;
export type S3Sdk = typeof import("@aws-sdk/client-s3");

function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function loadS3Sdk(): S3Sdk {
  return createRequire(import.meta.url)("@aws-sdk/client-s3") as S3Sdk;
}

/**
 * Build an `S3ObjectClient` whose SDK client is created lazily from the given environment.
 * `loadSdk` replaces the SDK loader (tests).
 */
export function createS3ClientFromEnv(env: Env, loadSdk: () => S3Sdk = loadS3Sdk): S3ObjectClient {
  const accessKeyId = setting(env, "BLOB_S3_ACCESS_KEY_ID");
  const secretAccessKey = setting(env, "BLOB_S3_SECRET_ACCESS_KEY");
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new Error("blob_s3_credentials_incomplete");
  }
  let loaded: { sdk: S3Sdk; client: InstanceType<S3Sdk["S3Client"]> } | null = null;
  const connect = async () => {
    if (loaded) return loaded;
    const sdk = loadSdk();
    loaded = {
      sdk,
      client: new sdk.S3Client({
        region: setting(env, "BLOB_S3_REGION") ?? "us-east-1",
        endpoint: setting(env, "BLOB_S3_ENDPOINT"),
        forcePathStyle: setting(env, "BLOB_S3_FORCE_PATH_STYLE") === "true",
        credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      }),
    };
    return loaded;
  };
  return {
    async putObject(input) {
      const { sdk, client } = await connect();
      return client.send(new sdk.PutObjectCommand(input));
    },
    async headObject(input) {
      const { sdk, client } = await connect();
      return client.send(new sdk.HeadObjectCommand(input));
    },
    async deleteObject(input) {
      const { sdk, client } = await connect();
      return client.send(new sdk.DeleteObjectCommand(input));
    },
    async listObjectsV2(input) {
      const { sdk, client } = await connect();
      return client.send(new sdk.ListObjectsV2Command(input));
    },
  };
}
