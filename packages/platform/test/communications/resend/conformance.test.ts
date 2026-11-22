import { describe, expect, it } from "vitest";
import type { EmailEgressPolicy, EmailMessage } from "../../../src/communications/index.js";
import { createResendTransport } from "../../../src/communications/resend/index.js";
import {
  createScriptedCommunicationsFake,
  runCommunicationsAdapterConformance,
  ScriptedCommunicationsTransportError,
  type CommunicationsAdapterConformanceSubject,
  type EmailFaultCertificationHarness,
  type ScriptedCommunicationsOutcome,
} from "../../../src/communications/testing/index.js";

type ResendHttpCalls = {
  send: Response;
};

const CANARY_CREDENTIAL = "comms-canary-marker/alpha+02";

const SAMPLE_MESSAGE: EmailMessage = {
  from: "store@example.invalid",
  to: "customer@example.invalid",
  subject: "Order confirmed",
  html: "<p>Confirmed</p>",
  idempotencyKey: "msg-resend-001",
};

function makePolicy(mode: "sandbox_direct" | "drop"): EmailEgressPolicy {
  return (intendedRecipient) =>
    mode === "drop"
      ? { mode: "drop", reason: "test_suppressed" }
      : {
          mode: "sandbox_direct",
          intendedRecipient,
          recipient: intendedRecipient,
          credential: CANARY_CREDENTIAL,
          environmentTag: "non_production",
          reason: "test_sandbox",
        };
}

function makeResendHarness(
  outcome: ScriptedCommunicationsOutcome<Response>,
  mode: "sandbox_direct" | "drop" = "sandbox_direct",
): EmailFaultCertificationHarness {
  const fake = createScriptedCommunicationsFake<ResendHttpCalls>();
  if (mode === "sandbox_direct") {
    fake.enqueue("send", outcome);
  }
  const fetchImpl: typeof fetch = async () => {
    try {
      return await fake.invoke("send");
    } catch (error) {
      if (error instanceof ScriptedCommunicationsTransportError) {
        if (error.kind === "http-failure") {
          return new Response(JSON.stringify({ message: `HTTP ${error.status}` }), {
            status: error.status ?? 500,
            headers: { "content-type": "application/json" },
          });
        }
        if (error.kind === "rate-limited-429") {
          return new Response(JSON.stringify({ message: "Rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
      }
      throw error;
    }
  };
  return {
    input: SAMPLE_MESSAGE,
    adapter: createResendTransport({
      policy: makePolicy(mode),
      environmentTagName: "openlup_env",
      fetch: fetchImpl,
    }),
    readEffectCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
  };
}

describe("Resend Tier 2 witness conformance", () => {
  it("passes runCommunicationsAdapterConformance in full mode offline", async () => {
    let idx = 0;
    const fixtures: readonly {
      readonly mode: "sandbox_direct" | "drop";
      readonly outcome: ScriptedCommunicationsOutcome<Response>;
    }[] = [
      {
        mode: "sandbox_direct",
        outcome: {
          kind: "success",
          value: new Response(JSON.stringify({ id: "re_msg_001" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        },
      },
      { mode: "sandbox_direct", outcome: { kind: "http-failure", status: 500 } },
      { mode: "drop", outcome: { kind: "success", value: new Response("{}", { status: 200 }) } },
    ];

    const subject: CommunicationsAdapterConformanceSubject = {
      kind: "email",
      subjectId: "tier2-resend-witness",
      sensitiveValues: [CANARY_CREDENTIAL],
      create: () => {
        const cfg = fixtures[idx++]!;
        const h = makeResendHarness(cfg.outcome, cfg.mode);
        return { adapter: h.adapter, readEffectCount: h.readEffectCount };
      },
      fixtures: [
        {
          input: SAMPLE_MESSAGE,
          expectedEffects: 1,
          expected: {
            outcome: {
              ok: true,
              resendId: "re_msg_001",
              httpStatus: 200,
              providerError: null,
              aborted: false,
              egressMode: "sandbox_direct",
              egressReason: "test_sandbox",
            },
            providerResponse: { id: "re_msg_001" },
          },
        },
        {
          input: SAMPLE_MESSAGE,
          expectedEffects: 1,
          expected: {
            outcome: {
              ok: false,
              resendId: null,
              httpStatus: 500,
              providerError: "HTTP 500",
              providerErrorCode: null,
              aborted: false,
              egressMode: "sandbox_direct",
              egressReason: "test_sandbox",
            },
            providerResponse: { http_status: 500, provider_error_message: "HTTP 500" },
          },
        },
        {
          input: SAMPLE_MESSAGE,
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
            providerResponse: { suppressed: "drop", egress_reason: "test_suppressed" },
          },
        },
      ],
      certification: {
        http5xx: () => makeResendHarness({ kind: "http-failure", status: 503 }),
        httpAuthFailure: () => makeResendHarness({ kind: "http-failure", status: 401 }),
        rateLimited429: () => makeResendHarness({ kind: "rate-limited-429", retryAfterSeconds: 20 }),
        timeout: () => makeResendHarness({ kind: "timeout" }),
        transportError: () => makeResendHarness({ kind: "transport-error" }),
      },
    };

    const evidence = await runCommunicationsAdapterConformance([subject], { mode: "full" });
    expect(evidence.qualifications).toHaveLength(1);
    expect(evidence.qualifications![0]!.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);
  });
});
