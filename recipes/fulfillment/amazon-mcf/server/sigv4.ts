import { createHash, createHmac } from "node:crypto";

export interface AwsSigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SignAwsRequestInput {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: URL;
  readonly region: "us-east-1" | "eu-west-1" | "us-west-2";
  readonly service: "execute-api";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly credentials: AwsSigV4Credentials;
  readonly timestampIso: string;
}

export interface SignedAwsHeaders {
  readonly headers: Record<string, string>;
  readonly amzDate: string;
  readonly signedHeaders: string;
  readonly credentialScope: string;
}

/** RFC 3986 strict percent-encoding required by AWS Signature Version 4. */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Canonical URI path for API Gateway / SP-API (`execute-api`).
 * AWS SigV4 for non-S3 services double-encodes each path segment.
 */
export function buildCanonicalUri(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "/";
  }
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const segments = normalized.split("/");
  return segments
    .map((segment, index) => {
      if (index === 0) return "";
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        decoded = segment;
      }
      return awsUriEncode(awsUriEncode(decoded));
    })
    .join("/");
}

/** Canonical query string sorted lexicographically by encoded key then encoded value. */
export function buildCanonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: Array<readonly [string, string]> = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([awsUriEncode(key), awsUriEncode(value)]);
  }
  pairs.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** Format an ISO-8601 timestamp into SigV4 `amzDate` (`YYYYMMDDTHHMMSSZ`) and `dateStamp` (`YYYYMMDD`). */
export function formatSigV4Timestamps(timestampIso: string): {
  readonly amzDate: string;
  readonly dateStamp: string;
} {
  const parsedMs = Date.parse(timestampIso);
  if (!Number.isFinite(parsedMs)) {
    throw new Error("amazon_mcf_invalid_clock_timestamp");
  }
  const iso = new Date(parsedMs).toISOString();
  const compact = iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return {
    amzDate: compact,
    dateStamp: compact.slice(0, 8),
  };
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Uint8Array, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * Pure `node:crypto` AWS Signature Version 4 (`AWS4-HMAC-SHA256`) request signer.
 * Never mutates input headers and never retains credentials beyond the call frame.
 */
export function signAwsV4Request(input: SignAwsRequestInput): SignedAwsHeaders {
  const accessKeyId = input.credentials.accessKeyId.trim();
  const secretAccessKey = input.credentials.secretAccessKey.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("amazon_mcf_aws_credentials_missing");
  }

  const { amzDate, dateStamp } = formatSigV4Timestamps(input.timestampIso);
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;

  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization") continue;
    merged[lower] = normalizeHeaderValue(value);
  }
  merged["host"] = input.url.host.toLowerCase();
  merged["x-amz-date"] = amzDate;
  if (input.credentials.sessionToken?.trim()) {
    merged["x-amz-security-token"] = normalizeHeaderValue(input.credentials.sessionToken);
  }

  const sortedHeaderKeys = Object.keys(merged).sort();
  const canonicalHeaders = sortedHeaderKeys.map((key) => `${key}:${merged[key]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");
  const payloadHash = sha256Hex(input.body);

  const canonicalRequest = [
    input.method,
    buildCanonicalUri(input.url.pathname),
    buildCanonicalQueryString(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outputHeaders: Record<string, string> = {
    ...merged,
    authorization,
  };
  delete outputHeaders["host"];

  return {
    headers: outputHeaders,
    amzDate,
    signedHeaders,
    credentialScope,
  };
}
