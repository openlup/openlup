import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  guardEmailTransport,
  type EmailObservationPort,
  type EmailSendResult,
  type EmailTransport,
} from "@openlup/platform/communications";
import {
  createScriptedCommunicationsFake,
  runCommunicationsAdapterConformance,
  ScriptedCommunicationsTransportError,
  type CommunicationsAdapterConformanceSubject,
  type EmailFaultCertificationHarness,
  type ScriptedCommunicationsOutcome,
} from "@openlup/platform/communications/testing";
import {
  POSTMARK_API_ORIGIN,
  POSTMARK_EMAIL_ENDPOINT,
  POSTMARK_OBSERVATION_EVENTS,
  POSTMARK_PROVIDER_KIND,
  PostmarkTransportError,
  createPostmarkEmailTransport,
  createPostmarkHttpClient,
  createPostmarkWebhookHandler,
  parseRetryAfterSeconds,
  postmarkStaticCapabilities,
  projectPostmarkStaticCapabilities,
  sanitizePostmarkText,
  verifyPostmarkBasicAuth,
  type PostmarkFetchLike,
} from "../server/index.js";
import {
  FIXTURE_ENVIRONMENT_TAG_NAME,
  FIXTURE_MESSAGE_STREAM,
  FIXTURE_NOW_ISO,
  FIXTURE_SENSITIVE_CANARIES,
  FIXTURE_SUBMITTED_AT,
  SAMPLE_EMAIL_MESSAGE,
  buildPostmarkWebhookPayload,
  encodeBasicAuthHeader,
  makeFixtureEgressPolicy,
} from "./fixtures.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const RECIPE_ROOT = resolve(THIS_DIR, "..");
const RECIPES_ROOT = resolve(RECIPE_ROOT, "..", "..");

function collectRelativeFiles(dir: string, root: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const collected: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectRelativeFiles(full, root));
    } else if (entry.isFile()) {
      collected.push(relative(root, full).replace(/\\/gu, "/"));
    }
  }
  return collected.sort();
}

interface JsonSchemaNode {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  uniqueItems?: boolean;
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  allOf?: readonly JsonSchemaNode[];
  if?: JsonSchemaNode;
  then?: JsonSchemaNode;
}

const RFC3339_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function validateAgainstJsonSchema(
  value: unknown,
  schema: JsonSchemaNode,
  pointer = "$",
): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pointer}: value ${JSON.stringify(value)} not in enum`);
  }
  if (schema.type) {
    const actualType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actualType !== schema.type) {
      errors.push(`${pointer}: expected type ${schema.type}, got ${actualType}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${pointer}: string ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    if (
      schema.format === "date-time"
      && (!RFC3339_DATE_TIME_REGEX.test(value) || !Number.isFinite(Date.parse(value)))
    ) {
      errors.push(`${pointer}: invalid date-time ${JSON.stringify(value)}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) {
        errors.push(`${pointer}: duplicate items violate uniqueItems`);
      }
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        errors.push(...validateAgainstJsonSchema(item, schema.items!, `${pointer}[${idx}]`));
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in record)) {
          errors.push(`${pointer}: missing required property ${JSON.stringify(key)}`);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          errors.push(`${pointer}: unexpected additional property ${JSON.stringify(key)}`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in record) {
          errors.push(...validateAgainstJsonSchema(record[key], propSchema, `${pointer}.${key}`));
        }
      }
    }
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) {
      if (branch.if && branch.then) {
        if (validateAgainstJsonSchema(value, branch.if, pointer).length === 0) {
          errors.push(...validateAgainstJsonSchema(value, branch.then, pointer));
        }
      } else {
        errors.push(...validateAgainstJsonSchema(value, branch, pointer));
      }
    }
  }
  return errors;
}

type PostmarkHttpCalls = {
  send: Response;
};

function makePostmarkHarness(
  outcome: ScriptedCommunicationsOutcome<Response>,
  mode: "sandbox_direct" | "drop" = "sandbox_direct",
  onRequest?: (url: string, init: RequestInit | undefined) => void,
): EmailFaultCertificationHarness {
  const fake = createScriptedCommunicationsFake<PostmarkHttpCalls>();
  if (mode === "sandbox_direct") {
    fake.enqueue("send", outcome);
  }
  const fetchImpl: PostmarkFetchLike = async (url, init) => {
    onRequest?.(url, init);
    try {
      return await fake.invoke("send");
    } catch (error) {
      if (error instanceof ScriptedCommunicationsTransportError) {
        if (error.kind === "http-failure") {
          return new Response(
            JSON.stringify({
              ErrorCode: error.status ?? 500,
              Message: `Postmark error for ${FIXTURE_SENSITIVE_CANARIES.recipientEmail} token ${FIXTURE_SENSITIVE_CANARIES.serverToken}`,
            }),
            {
              status: error.status ?? 500,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (error.kind === "rate-limited-429") {
          return new Response(JSON.stringify({ ErrorCode: 429, Message: "Rate limited" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              ...(error.retryAfterSeconds !== undefined
                ? { "retry-after": String(error.retryAfterSeconds) }
                : {}),
            },
          });
        }
      }
      throw error;
    }
  };
  const client = createPostmarkHttpClient({
    fetchImpl,
    messageStream: FIXTURE_MESSAGE_STREAM,
  });
  const adapter = createPostmarkEmailTransport({
    policy: makeFixtureEgressPolicy(mode),
    client,
    environmentTagName: FIXTURE_ENVIRONMENT_TAG_NAME,
  });
  return {
    input: SAMPLE_EMAIL_MESSAGE,
    adapter,
    readEffectCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
  };
}

function buildConformanceSubject(
  onRequest?: (url: string, init: RequestInit | undefined) => void,
): CommunicationsAdapterConformanceSubject {
  let fixtureIdx = 0;
  const fixtureConfigs: readonly {
    readonly mode: "sandbox_direct" | "drop";
    readonly outcome: ScriptedCommunicationsOutcome<Response>;
  }[] = [
    {
      mode: "sandbox_direct",
      outcome: {
        kind: "success",
        value: new Response(
          JSON.stringify({
            To: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
            SubmittedAt: FIXTURE_SUBMITTED_AT,
            MessageID: "pm-msg-001",
            ErrorCode: 0,
            Message: "OK",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      },
    },
    {
      mode: "sandbox_direct",
      outcome: { kind: "http-failure", status: 422 },
    },
    {
      mode: "drop",
      outcome: { kind: "success", value: new Response("{}", { status: 200 }) },
    },
  ];

  return {
    kind: "email",
    subjectId: "recipes-communications-postmark",
    sensitiveValues: [
      FIXTURE_SENSITIVE_CANARIES.serverToken,
      FIXTURE_SENSITIVE_CANARIES.recipientEmail,
    ],
    create: () => {
      const cfg = fixtureConfigs[fixtureIdx++]!;
      const harness = makePostmarkHarness(cfg.outcome, cfg.mode, onRequest);
      return { adapter: harness.adapter, readEffectCount: harness.readEffectCount };
    },
    fixtures: [
      {
        input: SAMPLE_EMAIL_MESSAGE,
        expectedEffects: 1,
        expected: {
          outcome: {
            ok: true,
            resendId: "pm-msg-001",
            httpStatus: 200,
            providerError: null,
            providerErrorCode: null,
            aborted: false,
            egressMode: "sandbox_direct",
            egressReason: "test_sandbox",
          },
          providerResponse: {
            message_id: "pm-msg-001",
            error_code: 0,
            submitted_at: FIXTURE_SUBMITTED_AT,
          },
        },
      },
      {
        input: SAMPLE_EMAIL_MESSAGE,
        expectedEffects: 1,
        expected: {
          outcome: {
            ok: false,
            resendId: null,
            httpStatus: 422,
            providerError: "postmark_http_422",
            providerErrorCode: "validation_failed",
            aborted: false,
            egressMode: "sandbox_direct",
            egressReason: "test_sandbox",
          },
          providerResponse: {
            message_id: null,
            error_code: null,
            submitted_at: null,
          },
        },
      },
      {
        input: SAMPLE_EMAIL_MESSAGE,
        expectedEffects: 0,
        expected: {
          outcome: {
            ok: true,
            resendId: null,
            httpStatus: 0,
            providerError: null,
            aborted: false,
            suppressed: "drop",
            egressMode: "drop",
            egressReason: "test_suppressed",
          },
          providerResponse: {
            suppressed: "drop",
            egress_reason: "test_suppressed",
          },
        },
      },
    ],
    certification: {
      http5xx: () => makePostmarkHarness({ kind: "http-failure", status: 503 }),
      httpAuthFailure: () => makePostmarkHarness({ kind: "http-failure", status: 401 }),
      rateLimited429: () => makePostmarkHarness({ kind: "rate-limited-429", retryAfterSeconds: 20 }),
      timeout: () => makePostmarkHarness({ kind: "timeout" }),
      transportError: () => makePostmarkHarness({ kind: "transport-error" }),
    },
  };
}

describe("recipes/communications/postmark — Stage 1 manifest, cold-import & schema parity", () => {
  it("validates recipe.json against recipes/schema/recipe.schema.json and rejects invalid manifests", () => {
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(validateAgainstJsonSchema(manifest, schema)).toEqual([]);

    const badManifest = {
      ...manifest,
      egressOrigins: ["http://insecure.example.com"],
      unexpectedKey: true,
      liveQualification: {
        status: "dated-sandbox-receipt",
        checklist: "LIVE_QUALIFICATION.md",
        qualifiedAt: "not-a-timestamp",
      },
    };
    expect(validateAgainstJsonSchema(badManifest, schema).length).toBeGreaterThanOrEqual(3);
  });

  it("matches recipe.json staticCapabilities and exact sorted disk allFiles inventory", () => {
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(manifest.id).toBe("communications/postmark");
    expect(manifest.providerKind).toBe(POSTMARK_PROVIDER_KIND);
    expect(manifest.staticCapabilities).toEqual(projectPostmarkStaticCapabilities());
    expect(manifest.summary.length).toBeLessThanOrEqual(240);

    const diskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    const manifestFiles = [...(manifest.files.allFiles as string[])];
    expect(manifestFiles).toEqual([...manifestFiles].sort());
    expect(manifestFiles).toEqual(diskFiles);
  });

  it("keeps server barrel import cold and inert (zero I/O or ambient side effects)", () => {
    expect(POSTMARK_PROVIDER_KIND).toBe("postmark");
    expect(POSTMARK_API_ORIGIN).toBe("https://api.postmarkapp.com");
    expect(POSTMARK_EMAIL_ENDPOINT).toBe("https://api.postmarkapp.com/email");
    expect(POSTMARK_OBSERVATION_EVENTS).toEqual([
      "Delivery",
      "Bounce",
      "SpamComplaint",
      "Open",
      "Click",
      "SubscriptionChange",
    ]);
    expect(postmarkStaticCapabilities).toEqual(projectPostmarkStaticCapabilities());
  });
});

describe("recipes/communications/postmark — Stage 2 full communications adapter conformance", () => {
  it("passes runCommunicationsAdapterConformance(..., { mode: 'full' }) with canary scanning and 5 fault scenarios", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const subject = buildConformanceSubject((url, init) => {
      requests.push({ url, init });
    });

    const evidence = await runCommunicationsAdapterConformance([subject], { mode: "full" });
    expect(evidence.subjects).toHaveLength(1);
    expect(evidence.subjects[0]!.cases).toEqual([
      "email:accepted",
      "email:failed",
      "email:suppressed",
      "email:fault:http-5xx",
      "email:fault:http-auth-failure",
      "email:fault:rate-limited-429",
      "email:fault:timeout",
      "email:fault:transport-error",
    ]);
    expect(evidence.qualifications).toHaveLength(1);
    const qual = evidence.qualifications![0]!;
    expect(qual.mode).toBe("full");
    expect(qual.capabilityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(qual.ledger.some((entry) => entry.role === "egress-admission")).toBe(true);
    expect(qual.ledger.filter((entry) => entry.role === "transport-fault")).toHaveLength(5);
    expect(
      qual.ledger
        .filter((entry) => entry.role === "transport-fault")
        .every((entry) => entry.faultLogDelta === 1 && entry.ioDelta === 1),
    ).toBe(true);

    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const req of requests) {
      expect(req.url).toBe(POSTMARK_EMAIL_ENDPOINT);
      expect(req.init?.redirect).toBe("error");
      const headers = req.init?.headers as Record<string, string>;
      expect(headers["X-Postmark-Server-Token"]).toBe(FIXTURE_SENSITIVE_CANARIES.serverToken);
      expect(headers["Accept"]).toBe("application/json");
      expect(headers["Content-Type"]).toBe("application/json");
      const parsedBody = JSON.parse(req.init?.body as string) as Record<string, unknown>;
      expect(parsedBody["MessageStream"]).toBe(FIXTURE_MESSAGE_STREAM);
      expect(parsedBody["Metadata"]).toEqual({
        [FIXTURE_ENVIRONMENT_TAG_NAME]: "non_production",
        idempotency_key: SAMPLE_EMAIL_MESSAGE.idempotencyKey,
      });
    }
  });

  it("enforces sandbox_sink routing with X-Original-Recipient header and metadata", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const client = createPostmarkHttpClient({
      fetchImpl: async (url, init) => {
        expect(url).toBe(POSTMARK_EMAIL_ENDPOINT);
        expect(init?.redirect).toBe("error");
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            MessageID: "pm-sink-001",
            ErrorCode: 0,
            SubmittedAt: FIXTURE_SUBMITTED_AT,
            Message: "OK",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      messageStream: "outbound-sink",
    });

    const adapter = createPostmarkEmailTransport({
      policy: makeFixtureEgressPolicy("sandbox_sink"),
      client,
      environmentTagName: FIXTURE_ENVIRONMENT_TAG_NAME,
    });
    expect(guardEmailTransport(adapter)).toBe(adapter);

    const result = await adapter.send({
      ...SAMPLE_EMAIL_MESSAGE,
      attachments: [{ filename: "invoice.pdf", content: "JVBERi0xLjQ=", }],
    });
    expect(result.outcome).toEqual({
      ok: true,
      resendId: "pm-sink-001",
      httpStatus: 200,
      providerError: null,
      providerErrorCode: null,
      aborted: false,
      egressMode: "sandbox_sink",
      egressReason: "test_sink",
    });
    expect(capturedBody).toEqual({
      From: SAMPLE_EMAIL_MESSAGE.from,
      To: FIXTURE_SENSITIVE_CANARIES.sinkEmail,
      Subject: SAMPLE_EMAIL_MESSAGE.subject,
      HtmlBody: SAMPLE_EMAIL_MESSAGE.html,
      TextBody: SAMPLE_EMAIL_MESSAGE.text,
      ReplyTo: SAMPLE_EMAIL_MESSAGE.replyTo,
      MessageStream: "outbound-sink",
      Metadata: {
        [FIXTURE_ENVIRONMENT_TAG_NAME]: "non_production",
        idempotency_key: SAMPLE_EMAIL_MESSAGE.idempotencyKey,
        original_recipient: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
      },
      Headers: [
        {
          Name: "X-Original-Recipient",
          Value: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
        },
      ],
      Attachments: [
        {
          Name: "invoice.pdf",
          Content: "JVBERi0xLjQ=",
          ContentType: "application/octet-stream",
        },
      ],
    });
  });

  it("maps 2xx non-zero ErrorCode cleanly and redacts email addresses and tokens", async () => {
    const client = createPostmarkHttpClient({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ErrorCode: 406,
            Message: `Inactive recipient ${FIXTURE_SENSITIVE_CANARIES.recipientEmail} for ${FIXTURE_SENSITIVE_CANARIES.serverToken}`,
            SubmittedAt: FIXTURE_SUBMITTED_AT,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const adapter = createPostmarkEmailTransport({
      policy: makeFixtureEgressPolicy("sandbox_direct"),
      client,
    });
    const result = await adapter.send(SAMPLE_EMAIL_MESSAGE);
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.resendId).toBeNull();
    expect(result.outcome.httpStatus).toBe(200);
    expect(result.outcome.providerErrorCode).toBe("406");
    expect(result.outcome.providerError).toBe("Inactive recipient [email] for [redacted]");
    expect(JSON.stringify(result)).not.toContain(FIXTURE_SENSITIVE_CANARIES.recipientEmail);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_SENSITIVE_CANARIES.serverToken);
  });
});

describe("recipes/communications/postmark — HTTP client hardening unit tests", () => {
  it("enforces streaming byte cap (reader + content-length) and cancels oversized/non-2xx bodies cleanly", async () => {
    let cancelledNon2xx = false;
    const non2xxStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("secret raw error body"));
        controller.close();
      },
      cancel() {
        cancelledNon2xx = true;
      },
    });
    const non2xxClient = createPostmarkHttpClient({
      fetchImpl: async () =>
        new Response(non2xxStream, {
          status: 429,
          headers: { "retry-after": "45" },
        }),
    });
    await expect(
      non2xxClient.sendEmail({
        serverToken: FIXTURE_SENSITIVE_CANARIES.serverToken,
        from: SAMPLE_EMAIL_MESSAGE.from,
        to: SAMPLE_EMAIL_MESSAGE.to,
        subject: SAMPLE_EMAIL_MESSAGE.subject,
        htmlBody: SAMPLE_EMAIL_MESSAGE.html,
      }),
    ).rejects.toMatchObject({
      name: "PostmarkTransportError",
      code: "postmark_rate_limited",
      httpStatus: 429,
      retryAfterSeconds: 45,
      aborted: false,
    });
    expect(cancelledNon2xx).toBe(true);

    let cancelledOversize = false;
    const chunkedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelledOversize = true;
      },
    });
    const cappedClient = createPostmarkHttpClient({
      fetchImpl: async () => new Response(chunkedStream, { status: 200 }),
      maxResponseBytes: 100,
    });
    await expect(
      cappedClient.sendEmail({
        serverToken: FIXTURE_SENSITIVE_CANARIES.serverToken,
        from: SAMPLE_EMAIL_MESSAGE.from,
        to: SAMPLE_EMAIL_MESSAGE.to,
        subject: SAMPLE_EMAIL_MESSAGE.subject,
        htmlBody: SAMPLE_EMAIL_MESSAGE.html,
      }),
    ).rejects.toMatchObject({
      name: "PostmarkTransportError",
      code: "postmark_response_too_large",
      httpStatus: 200,
      aborted: false,
    });
    expect(cancelledOversize).toBe(true);

    let cancelledHeaderOversize = false;
    const headerStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelledHeaderOversize = true;
      },
    });
    const headerCappedClient = createPostmarkHttpClient({
      fetchImpl: async () =>
        new Response(headerStream, {
          status: 200,
          headers: { "content-length": "9999999" },
        }),
      maxResponseBytes: 1024,
    });
    await expect(
      headerCappedClient.sendEmail({
        serverToken: FIXTURE_SENSITIVE_CANARIES.serverToken,
        from: SAMPLE_EMAIL_MESSAGE.from,
        to: SAMPLE_EMAIL_MESSAGE.to,
        subject: SAMPLE_EMAIL_MESSAGE.subject,
        htmlBody: SAMPLE_EMAIL_MESSAGE.html,
      }),
    ).rejects.toMatchObject({
      code: "postmark_response_too_large",
    });
    expect(cancelledHeaderOversize).toBe(true);
  });

  it("rejects invalid serverToken before network I/O, composes caller AbortSignal, parses Retry-After, and sanitizes text", async () => {
    let fetchCalls = 0;
    const client = createPostmarkHttpClient({
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    await expect(
      client.sendEmail({
        serverToken: "bad\ntoken",
        from: SAMPLE_EMAIL_MESSAGE.from,
        to: SAMPLE_EMAIL_MESSAGE.to,
        subject: SAMPLE_EMAIL_MESSAGE.subject,
        htmlBody: SAMPLE_EMAIL_MESSAGE.html,
      }),
    ).rejects.toMatchObject({
      code: "postmark_invalid_server_token",
      httpStatus: 0,
      aborted: false,
    });
    expect(fetchCalls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.sendEmail({
        serverToken: FIXTURE_SENSITIVE_CANARIES.serverToken,
        from: SAMPLE_EMAIL_MESSAGE.from,
        to: SAMPLE_EMAIL_MESSAGE.to,
        subject: SAMPLE_EMAIL_MESSAGE.subject,
        htmlBody: SAMPLE_EMAIL_MESSAGE.html,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "postmark_timeout",
      httpStatus: 0,
      aborted: true,
    });
    expect(fetchCalls).toBe(0);

    const inflightController = new AbortController();
    const inflightPromise = client.sendEmail({
      serverToken: FIXTURE_SENSITIVE_CANARIES.serverToken,
      from: SAMPLE_EMAIL_MESSAGE.from,
      to: SAMPLE_EMAIL_MESSAGE.to,
      subject: SAMPLE_EMAIL_MESSAGE.subject,
      htmlBody: SAMPLE_EMAIL_MESSAGE.html,
      signal: inflightController.signal,
    });
    inflightController.abort();
    await expect(inflightPromise).rejects.toMatchObject({
      code: "postmark_timeout",
      httpStatus: 0,
      aborted: true,
    });
    expect(fetchCalls).toBe(1);

    expect(parseRetryAfterSeconds("120")).toBe(120);
    expect(parseRetryAfterSeconds("Sat, 15 Apr 2000 10:31:00 GMT", Date.parse(FIXTURE_NOW_ISO))).toBe(60);
    expect(parseRetryAfterSeconds("invalid")).toBeNull();
    expect(
      sanitizePostmarkText(
        `Failed for alice@example.com using ${FIXTURE_SENSITIVE_CANARIES.serverToken}`,
        [FIXTURE_SENSITIVE_CANARIES.serverToken],
      ),
    ).toBe("Failed for [email] using [redacted]");
  });
});

describe("recipes/communications/postmark — Webhook Basic Auth & normalization tests", () => {
  function makeTestPort(found = true) {
    const calls: unknown[] = [];
    const port: EmailObservationPort = {
      findSend: async (messageId) => {
        calls.push(["findSend", messageId]);
        return found ? { id: `send:${messageId}` } : null;
      },
      applyObservation: async (obs) => {
        calls.push(["applyObservation", obs]);
      },
      recordAttempt: async (attempt) => {
        calls.push(["recordAttempt", attempt]);
      },
    };
    return { port, calls };
  }

  it("verifies Basic Auth in constant time and enforces scheme, length, and non-empty credentials", () => {
    const validHeader = encodeBasicAuthHeader(
      FIXTURE_SENSITIVE_CANARIES.webhookUsername,
      FIXTURE_SENSITIVE_CANARIES.webhookPassword,
    );
    expect(
      verifyPostmarkBasicAuth({
        authorizationHeader: validHeader,
        username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
        password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
      }),
    ).toBe(true);

    for (const badHeader of [
      undefined,
      null,
      "",
      "Bearer something",
      `basic ${validHeader.slice(6)}`,
      `${validHeader} `,
      encodeBasicAuthHeader(FIXTURE_SENSITIVE_CANARIES.webhookUsername, "wrong-password"),
      encodeBasicAuthHeader("wrong-user", FIXTURE_SENSITIVE_CANARIES.webhookPassword),
      encodeBasicAuthHeader(
        FIXTURE_SENSITIVE_CANARIES.webhookUsername,
        `${FIXTURE_SENSITIVE_CANARIES.webhookPassword}x`,
      ),
    ]) {
      expect(
        verifyPostmarkBasicAuth({
          authorizationHeader: badHeader,
          username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
          password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
        }),
      ).toBe(false);
    }

    expect(
      verifyPostmarkBasicAuth({
        authorizationHeader: encodeBasicAuthHeader("", ""),
        username: "",
        password: "",
      }),
    ).toBe(false);
  });

  it("authenticates before JSON.parse, enforces byte cap (256 KiB), rejects bad JSON with 400, and normalizes Postmark events", async () => {
    const validAuth = encodeBasicAuthHeader(
      FIXTURE_SENSITIVE_CANARIES.webhookUsername,
      FIXTURE_SENSITIVE_CANARIES.webhookPassword,
    );

    // Auth-before-parse: invalid JSON + missing/wrong auth => 401 with 0 port calls
    {
      const { port, calls } = makeTestPort();
      const handler = createPostmarkWebhookHandler({
        port,
        username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
        password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
        receivedAt: () => new Date(FIXTURE_NOW_ISO),
      });
      const unauthInvalidJson = await handler({
        rawBody: "{not-json",
        headers: { authorization: "Basic d3Jvbmc6d3Jvbmc=" },
      });
      expect(unauthInvalidJson).toEqual({ status: 401, body: { error: "Unauthorized" } });
      expect(calls).toHaveLength(0);

      // Valid auth + invalid JSON => 400 with 0 port calls
      const authInvalidJson = await handler({
        rawBody: "{not-json",
        headers: { Authorization: validAuth },
      });
      expect(authInvalidJson).toEqual({ status: 400, body: { error: "Invalid JSON payload" } });
      expect(calls).toHaveLength(0);

      // OPTIONS preflight
      expect(await handler({ method: "OPTIONS", rawBody: "" })).toEqual({ status: 200, body: "ok" });
    }

    // Byte cap exceeded (default 256 KiB and custom cap)
    {
      const { port, calls } = makeTestPort();
      const handler = createPostmarkWebhookHandler({
        port,
        username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
        password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
      });
      const oversized = JSON.stringify({
        RecordType: "Delivery",
        MessageID: "pm-msg-big",
        Padding: "x".repeat(262_200),
      });
      const res = await handler({
        rawBody: oversized,
        headers: { authorization: validAuth },
      });
      expect(res).toEqual({ status: 413, body: { error: "Payload too large" } });
      expect(calls).toHaveLength(0);
    }

    // Event normalization across all 6 RecordTypes + unknown/missing MessageID ignored
    {
      const { port, calls } = makeTestPort(true);
      const handler = createPostmarkWebhookHandler({
        port,
        username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
        password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
        receivedAt: () => new Date(FIXTURE_NOW_ISO),
      });

      const cases: readonly [
        "Delivery" | "Bounce" | "SpamComplaint" | "Open" | "Click" | "SubscriptionChange",
        string,
      ][] = [
        ["Delivery", "email.delivered"],
        ["Bounce", "email.bounced"],
        ["SpamComplaint", "email.complained"],
        ["Open", "email.opened"],
        ["Click", "email.clicked"],
        ["SubscriptionChange", "email.suppressed"],
      ];

      for (const [recordType, expectedEventType] of cases) {
        const res = await handler({
          rawBody: Buffer.from(JSON.stringify(buildPostmarkWebhookPayload(recordType)), "utf8"),
          headers: { authorization: validAuth },
        });
        expect(res).toEqual({ status: 200, body: { success: true } });
        const lastApply = calls.findLast((c) => Array.isArray(c) && c[0] === "applyObservation") as
          | [string, Record<string, unknown>]
          | undefined;
        expect(lastApply?.[1]).toMatchObject({
          sendId: "send:pm-msg-001",
          messageId: "pm-msg-001",
          eventType: expectedEventType,
          eventAt: FIXTURE_NOW_ISO,
        });
      }

      const callsBeforeIgnored = calls.length;
      for (const ignoredPayload of [
        { RecordType: "UnknownEvent", MessageID: "pm-msg-001" },
        { RecordType: "constructor", MessageID: "pm-msg-001" },
        { RecordType: "Delivery" },
        { RecordType: "Delivery", MessageID: "   " },
      ]) {
        const res = await handler({
          rawBody: JSON.stringify(ignoredPayload),
          headers: { authorization: validAuth },
        });
        expect(res).toEqual({ status: 200, body: { ignored: true } });
      }
      expect(calls.length).toBe(callsBeforeIgnored);
    }
  });
});

describe("recipes/communications/postmark — planted-defect negative controls", () => {
  it("NC1: rejects raw unadmitted EmailTransport in full conformance mode (egress_unadmitted)", async () => {
    const base = buildConformanceSubject();
    if (base.kind !== "email") throw new Error("expected email subject");
    const unadmittedSubject: CommunicationsAdapterConformanceSubject = {
      ...base,
      create: () => {
        const raw: EmailTransport = {
          providerKind: POSTMARK_PROVIDER_KIND,
          send: async (): Promise<EmailSendResult> => ({
            outcome: { ok: true, resendId: "pm-raw", httpStatus: 200, providerError: null, aborted: false },
            providerResponse: { message_id: "pm-raw", error_code: 0, submitted_at: FIXTURE_SUBMITTED_AT },
          }),
        };
        return { adapter: raw, readEffectCount: () => 1 };
      },
    };

    await expect(runCommunicationsAdapterConformance([unadmittedSubject], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:egress_unadmitted/u,
    );
  });

  it("NC2: detects leaked serverToken canary in outcome (secret_leak)", async () => {
    const base = buildConformanceSubject();
    if (base.kind !== "email") throw new Error("expected email subject");
    const leakySubject: CommunicationsAdapterConformanceSubject = {
      ...base,
      create: () => {
        const leakyClient = {
          sendEmail: async () => {
            throw new PostmarkTransportError({
              code: `leaked_${FIXTURE_SENSITIVE_CANARIES.serverToken}`,
              httpStatus: 500,
              aborted: false,
            });
          },
        };
        const adapter = createPostmarkEmailTransport({
          policy: makeFixtureEgressPolicy("sandbox_direct"),
          client: leakyClient,
        });
        return { adapter, readEffectCount: () => 1 };
      },
    };

    await expect(runCommunicationsAdapterConformance([leakySubject], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:secret_leak/u,
    );
  });

  it("NC3: wrong Basic Auth header rejects valid Postmark webhook with 401 and 0 port calls", async () => {
    let portCalls = 0;
    const port: EmailObservationPort = {
      findSend: async () => {
        portCalls += 1;
        return { id: "send-1" };
      },
      applyObservation: async () => {
        portCalls += 1;
      },
      recordAttempt: async () => {
        portCalls += 1;
      },
    };
    const handler = createPostmarkWebhookHandler({
      port,
      username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
      password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
    });
    const res = await handler({
      rawBody: JSON.stringify(buildPostmarkWebhookPayload("Delivery")),
      headers: {
        authorization: encodeBasicAuthHeader(
          FIXTURE_SENSITIVE_CANARIES.webhookUsername,
          "wrong-webhook-password",
        ),
      },
    });
    expect(res).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(portCalls).toBe(0);
  });
});
