// Transport-contract proof for the object-storage adapter; companion to blobStorage.test.ts.
//
// That file replaces the whole package with `vi.mock`, so it proves the adapter's mapping
// and never executes one line of the library. This file executes the library for real —
// credential resolution, request construction, `fetch`, response and error mapping — and
// mocks ONLY the wire, via an `undici` MockAgent resolved from the library's own directory.
//
// docs/TESTING.md, "Third-Party Transport Contract Tests", owns the full rationale: why the
// dispatcher must be bound to the library's own `undici` copy rather than a bare import, why
// the OIDC token must always be stubbed (an unstubbed run reaches the local CLI credential
// store, the keyring and the network), and the RE-BASELINE RULE — the endpoint, header names
// and `x-api-version` pinned below characterize the shipped library, so a bump that changes
// them must enumerate every changed expectation rather than relax an assertion.

import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createVercelBlobStorage } from "./blobStorage.js";

const BLOB_API_ORIGIN = "https://vercel.com";
const BLOB_API_BASE_PATH = "/api/blob";
/** Pinned `x-api-version` of the currently shipped package. See the RE-BASELINE RULE above. */
const EXPECTED_API_VERSION = "12";
const CACHE_MAX_AGE_SECONDS = String(60 * 60 * 24 * 30);
/** Public CDN host the API answers with; derived from the store id in the read-write token. */
const PUBLIC_CDN_ORIGIN = "https://store123.public.blob.vercel-storage.com";
const objectUrl = (key: string): string => `${PUBLIC_CDN_ORIGIN}/${key}`;

const READ_WRITE_TOKEN = "vercel_blob_rw_Store123_secretpart";
/** Adapter-level token override; must NOT reach the wire (only `urlFor()` consumes it). */
const ADAPTER_ONLY_TOKEN = "vercel_blob_rw_AdapterOnly_neverOnTheWire";

/** Minimal unsigned JWT shaped like an OIDC token; `exp` is year 2100, not `Date.now()`. */
function syntheticOidcToken(): string {
  const segment = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    segment({ alg: "RS256", typ: "JWT" }),
    segment({
      iss: "https://oidc.example.test/issuer",
      sub: "owner:example:project:example",
      aud: "https://example.test/audience",
      exp: 4102444800,
    }),
    "not-a-real-signature",
  ].join(".");
}

const OIDC_TOKEN = syntheticOidcToken();

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

type UndiciTestApi = {
  MockAgent: new () => {
    disableNetConnect: () => void;
    get: (origin: string) => {
      intercept: (options: { path: () => boolean; method: string }) => {
        reply: (
          status: number,
          data: unknown | ((options: Record<string, unknown>) => unknown),
          responseOptions?: { headers?: Record<string, string> },
        ) => { persist: () => void; times: (n: number) => void };
      };
    };
    close: () => Promise<void>;
  };
  setGlobalDispatcher: (dispatcher: unknown) => void;
  getGlobalDispatcher: () => unknown;
};

/**
 * Load `undici` the way the library loads it. Resolving from the library's own directory is
 * what makes the intercept binding provable rather than incidental.
 */
function loadLibraryTransport(): UndiciTestApi {
  const require = createRequire(import.meta.url);
  const blobDistDir = path.dirname(require.resolve("@vercel/blob"));
  return require(require.resolve("undici", { paths: [blobDistDir] })) as UndiciTestApi;
}

const undici = loadLibraryTransport();

let previousDispatcher: unknown;
let mockAgent: InstanceType<UndiciTestApi["MockAgent"]>;
let captured: CapturedRequest[];

/** Record every intercepted request and answer it with `body`. */
function interceptOnce(method: string, status: number, body: unknown, contentType?: string): void {
  mockAgent
    .get(BLOB_API_ORIGIN)
    .intercept({ path: () => true, method })
    .reply(
      status,
      (options: Record<string, unknown>) => {
        captured.push({
          method: String(options.method),
          path: String(options.path),
          headers: options.headers as Record<string, string>,
          // GET/HEAD arrive with a null body; PUT bodies are Buffers, POST bodies strings.
          body: options.body == null ? "" : Buffer.from(options.body as Uint8Array).toString("utf8"),
        });
        return body;
      },
      contentType ? { headers: { "content-type": contentType } } : undefined,
    );
}

function blobApiJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: objectUrl("objects/a.png"),
    downloadUrl: `${objectUrl("objects/a.png")}?download=1`,
    pathname: "objects/a.png",
    contentType: "image/png",
    contentDisposition: 'inline; filename="a.png"',
    cacheControl: `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
    size: 3,
    uploadedAt: "2026-06-01T00:00:00.000Z",
    etag: "etag-a",
    ...overrides,
  };
}

beforeAll(() => {
  previousDispatcher = undici.getGlobalDispatcher();
});

beforeEach(() => {
  captured = [];
  mockAgent = new undici.MockAgent();
  // Any request this suite fails to intercept becomes a hard error instead of real egress.
  mockAgent.disableNetConnect();
  undici.setGlobalDispatcher(mockAgent);
  // Binding guard: the library's own undici must hand out the mock, not a live Agent.
  expect(undici.getGlobalDispatcher()).toBe(mockAgent);

  vi.stubEnv("VERCEL_OIDC_TOKEN", OIDC_TOKEN);
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", READ_WRITE_TOKEN);
  vi.stubEnv("BLOB_STORE_ID", undefined);
  // Deterministic retry budget: async-retry defaults to 10 attempts with growing backoff.
  vi.stubEnv("VERCEL_BLOB_RETRIES", "0");
  vi.stubEnv("VERCEL_BLOB_API_URL", undefined);
  vi.stubEnv("VERCEL_BLOB_API_VERSION_OVERRIDE", undefined);
  vi.stubEnv("VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API", undefined);
});

afterEach(async () => {
  await mockAgent.close();
  vi.unstubAllEnvs();
});

afterAll(() => {
  // Never leak a mock dispatcher into another suite sharing this worker.
  undici.setGlobalDispatcher(previousDispatcher);
});

describe("blob adapter over the real @vercel/blob transport", () => {
  it("upload issues the pinned PUT request with the adapter's option headers", async () => {
    interceptOnce("PUT", 200, blobApiJson());

    const blob = createVercelBlobStorage({ token: ADAPTER_ONLY_TOKEN });
    const result = await blob.upload("objects/a.png", Buffer.from("png"), {
      contentType: "image/png",
    });

    // Execution proof: without a real library run there is no captured request at all.
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.method).toBe("PUT");
    expect(request.path).toBe(`${BLOB_API_BASE_PATH}/?pathname=objects%2Fa.png`);
    expect(request.body).toBe("png");
    expect(request.headers["x-vercel-blob-access"]).toBe("public");
    expect(request.headers["x-content-type"]).toBe("image/png");
    expect(request.headers["x-add-random-suffix"]).toBe("0");
    expect(request.headers["x-cache-control-max-age"]).toBe(CACHE_MAX_AGE_SECONDS);
    expect(request.headers["x-api-version"]).toBe(EXPECTED_API_VERSION);

    expect(result).toEqual({
      url: objectUrl("objects/a.png"),
      pathname: "objects/a.png",
    });
  });

  it("resolves credentials from the environment, never from the adapter's token option", async () => {
    interceptOnce("PUT", 200, blobApiJson());

    // `urlFor()` uses the adapter token; the library call must still use the env token.
    const blob = createVercelBlobStorage({ token: ADAPTER_ONLY_TOKEN });
    expect(blob.urlFor("objects/a.png")).toBe(
      "https://adapteronly.public.blob.vercel-storage.com/objects/a.png",
    );
    await blob.upload("objects/a.png", Buffer.from("png"));

    const request = captured[0]!;
    expect(request.headers.authorization).toBe(`Bearer ${READ_WRITE_TOKEN}`);
    expect(request.headers.authorization).not.toContain("AdapterOnly");
    // Store id travels as its own header because it is not encoded in an OIDC token.
    expect(request.headers["x-vercel-blob-store-id"]).toBe("Store123");
  });

  it("puts the token returned by the real getVercelOidcToken() on the wire when a store id is set", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", undefined);
    vi.stubEnv("BLOB_STORE_ID", "store_OidcStore9");
    interceptOnce("PUT", 200, blobApiJson());

    await createVercelBlobStorage().upload("objects/a.png", Buffer.from("png"));

    const request = captured[0]!;
    // The exact synthetic JWT round-tripped through the OIDC package and onto the request.
    expect(request.headers.authorization).toBe(`Bearer ${OIDC_TOKEN}`);
    // `store_` prefix normalized away by the library.
    expect(request.headers["x-vercel-blob-store-id"]).toBe("OidcStore9");
  });

  it("listDetailed issues a prefix GET and maps uploadedAt to a Date", async () => {
    interceptOnce("GET", 200, {
      hasMore: false,
      blobs: [
        blobApiJson(),
        blobApiJson({
          url: objectUrl("objects/b.png"),
          pathname: "objects/b.png",
          uploadedAt: "2026-06-02T12:30:00.000Z",
        }),
      ],
    });

    const { blobs } = await createVercelBlobStorage().listDetailed("objects/");

    const request = captured[0]!;
    expect(request.method).toBe("GET");
    expect(request.path).toBe(`${BLOB_API_BASE_PATH}?prefix=objects%2F`);
    expect(blobs).toEqual([
      {
        pathname: "objects/a.png",
        url: objectUrl("objects/a.png"),
        uploadedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        pathname: "objects/b.png",
        url: objectUrl("objects/b.png"),
        uploadedAt: new Date("2026-06-02T12:30:00.000Z"),
      },
    ]);
    // The TTL cron compares uploadedAt.getTime(); a string here would silently never expire.
    expect(blobs[0]!.uploadedAt).toBeInstanceOf(Date);
  });

  it("exists issues a url GET and returns true for a found blob", async () => {
    interceptOnce("GET", 200, blobApiJson());

    const found = await createVercelBlobStorage().exists("objects/a.png");

    expect(found).toBe(true);
    const request = captured[0]!;
    expect(request.method).toBe("GET");
    expect(request.path).toBe(
      `${BLOB_API_BASE_PATH}?url=${encodeURIComponent(
        objectUrl("objects/a.png"),
      )}`,
    );
  });

  it("exists swallows a real BlobNotFoundError into false", async () => {
    interceptOnce("GET", 404, { error: { code: "not_found", message: "Not found" } });

    expect(await createVercelBlobStorage().exists("objects/missing.png")).toBe(false);
    expect(captured).toHaveLength(1);
  });

  it("delete posts a JSON urls envelope to the delete endpoint", async () => {
    const url = objectUrl("objects/a.png");
    interceptOnce("POST", 200, null);

    await createVercelBlobStorage().delete(url);

    const request = captured[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(`${BLOB_API_BASE_PATH}/delete`);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body)).toEqual({ urls: [url] });
  });

  it("maps a JSON 403 to a typed access error the cron can report", async () => {
    interceptOnce("POST", 403, { error: { code: "forbidden", message: "Access denied" } });

    await expect(
      createVercelBlobStorage().delete(
        objectUrl("objects/a.png"),
      ),
    ).rejects.toThrow(/Access denied/);
    expect(captured).toHaveLength(1);
  });

  it("survives a non-JSON 5xx body and reports it as an unknown blob error", async () => {
    // 2026-07-31 incident class: an edge/proxy 5xx answers with HTML, not the JSON envelope.
    interceptOnce("GET", 502, "<html><head><title>502 Bad Gateway</title></head></html>", "text/html");

    await expect(
      createVercelBlobStorage().listDetailed("objects/"),
    ).rejects.toThrow(/Vercel Blob: Unknown error/);
    expect(captured).toHaveLength(1);
  });

  it("retries an unparseable 5xx but bails immediately on a typed 4xx", async () => {
    vi.stubEnv("VERCEL_BLOB_RETRIES", "1");

    interceptOnce("GET", 502, "<html>502 Bad Gateway</html>", "text/html");
    interceptOnce("GET", 502, "<html>502 Bad Gateway</html>", "text/html");
    await expect(
      createVercelBlobStorage().listDetailed("objects/"),
    ).rejects.toThrow(/Vercel Blob: Unknown error/);
    // retries=1 means exactly one retry: an opaque 5xx is retryable.
    expect(captured).toHaveLength(2);

    captured = [];
    interceptOnce("GET", 404, { error: { code: "not_found", message: "Not found" } });
    await expect(
      createVercelBlobStorage().listDetailed("objects/"),
    ).rejects.toThrow(/does not exist/);
    // A typed 4xx must bail on the first attempt; retrying it would multiply cron load.
    expect(captured).toHaveLength(1);
  });
});
