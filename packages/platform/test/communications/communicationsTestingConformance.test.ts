import { describe, expect, it } from "vitest";
import {
  createGuardedEmailTransport,
  type EmailEgressPolicy,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
} from "../../src/communications/index.js";
import {
  createScriptedCommunicationsFake,
  runCommunicationsAdapterConformance,
  ScriptedCommunicationsTransportError,
  type CommunicationsAdapterConformanceSubject,
  type EmailFaultCertificationHarness,
  type ScriptedCommunicationsOutcome,
} from "../../src/communications/testing/index.js";

type SyntheticEmailCalls = {
  send: { readonly id: string; readonly status: number };
};

const CANARY_CREDENTIAL = "comms-canary-marker/alpha+01";

const SAMPLE_MESSAGE: EmailMessage = {
  from: "store@example.invalid",
  to: "customer@example.invalid",
  subject: "Order confirmed",
  html: "<p>Confirmed</p>",
  idempotencyKey: "msg-001",
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

function makeSyntheticHarness(
  outcome: ScriptedCommunicationsOutcome<{ readonly id: string; readonly status: number }>,
  mode: "sandbox_direct" | "drop" = "sandbox_direct",
): EmailFaultCertificationHarness {
  const fake = createScriptedCommunicationsFake<SyntheticEmailCalls>();
  if (mode === "sandbox_direct") {
    fake.enqueue("send", outcome);
  }
  const adapter = createGuardedEmailTransport({
    providerKind: "synthetic_mail",
    policy: makePolicy(mode),
    async send(): Promise<EmailSendResult> {
      try {
        const res = await fake.invoke("send");
        return {
          outcome: {
            ok: true,
            resendId: res.id,
            httpStatus: res.status,
            providerError: null,
            aborted: false,
          },
          providerResponse: { id: res.id },
        };
      } catch (error) {
        if (error instanceof ScriptedCommunicationsTransportError) {
          if (error.kind === "timeout") {
            return {
              outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "timeout", aborted: true },
              providerResponse: { exception: true, aborted: true },
            };
          }
          if (error.kind === "rate-limited-429") {
            return {
              outcome: { ok: false, resendId: null, httpStatus: 429, providerError: "rate_limited", aborted: false },
              providerResponse: { http_status: 429 },
            };
          }
          if (error.kind === "http-failure") {
            const status = error.status ?? 500;
            return {
              outcome: { ok: false, resendId: null, httpStatus: status, providerError: `HTTP ${status}`, aborted: false },
              providerResponse: { http_status: status },
            };
          }
          return {
            outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "transport_error", aborted: false },
            providerResponse: { exception: true, aborted: false },
          };
        }
        return {
          outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "unexpected_error", aborted: false },
          providerResponse: { exception: true, aborted: false },
        };
      }
    },
  });
  return {
    input: SAMPLE_MESSAGE,
    adapter,
    readEffectCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
  };
}

function buildSyntheticSubject(): CommunicationsAdapterConformanceSubject {
  let fixtureIdx = 0;
  const fixtureConfigs: readonly {
    readonly mode: "sandbox_direct" | "drop";
    readonly outcome: ScriptedCommunicationsOutcome<{ readonly id: string; readonly status: number }>;
  }[] = [
    { mode: "sandbox_direct", outcome: { kind: "success", value: { id: "msg_syn_001", status: 200 } } },
    { mode: "sandbox_direct", outcome: { kind: "http-failure", status: 500 } },
    { mode: "drop", outcome: { kind: "success", value: { id: "unused", status: 200 } } },
  ];

  return {
    kind: "email",
    subjectId: "synthetic-email-witness",
    sensitiveValues: [CANARY_CREDENTIAL],
    create: () => {
      const cfg = fixtureConfigs[fixtureIdx++]!;
      const harness = makeSyntheticHarness(cfg.outcome, cfg.mode);
      return { adapter: harness.adapter, readEffectCount: harness.readEffectCount };
    },
    fixtures: [
      {
        input: SAMPLE_MESSAGE,
        expectedEffects: 1,
        expected: {
          outcome: {
            ok: true,
            resendId: "msg_syn_001",
            httpStatus: 200,
            providerError: null,
            aborted: false,
            egressMode: "sandbox_direct",
            egressReason: "test_sandbox",
          },
          providerResponse: { id: "msg_syn_001" },
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
            aborted: false,
            egressMode: "sandbox_direct",
            egressReason: "test_sandbox",
          },
          providerResponse: { http_status: 500 },
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
      http5xx: () => makeSyntheticHarness({ kind: "http-failure", status: 503 }),
      httpAuthFailure: () => makeSyntheticHarness({ kind: "http-failure", status: 401 }),
      rateLimited429: () => makeSyntheticHarness({ kind: "rate-limited-429", retryAfterSeconds: 20 }),
      timeout: () => makeSyntheticHarness({ kind: "timeout" }),
      transportError: () => makeSyntheticHarness({ kind: "transport-error" }),
    },
  };
}

describe("@openlup/platform/communications/testing", () => {
  it("certifies a guarded email adapter in full mode with egress admission and authenticated fault ledger", async () => {
    const evidence = await runCommunicationsAdapterConformance([buildSyntheticSubject()], { mode: "full" });
    expect(evidence.subjects).toHaveLength(1);
    expect(evidence.qualifications).toHaveLength(1);
    const qual = evidence.qualifications![0]!;
    expect(qual.subjectId).toBe("synthetic-email-witness");
    expect(qual.mode).toBe("full");
    expect(qual.capabilityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(qual.ledger.some((e) => e.role === "egress-admission")).toBe(true);
    expect(qual.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);
    expect(qual.ledger.filter((e) => e.role === "transport-fault").every((e) => e.faultLogDelta === 1)).toBe(true);
  });

  it("rejects raw unadmitted EmailTransport in full mode (negative control)", async () => {
    const base = buildSyntheticSubject();
    if (base.kind !== "email") throw new Error("expected email");
    const rawUnadmitted: CommunicationsAdapterConformanceSubject = {
      ...base,
      create: () => {
        const raw: EmailTransport = {
          providerKind: "raw_unadmitted",
          send: async (): Promise<EmailSendResult> => ({
            outcome: { ok: true, resendId: "x", httpStatus: 200, providerError: null, aborted: false },
            providerResponse: { id: "x" },
          }),
        };
        return { adapter: raw, readEffectCount: () => 1 };
      },
    };
    await expect(runCommunicationsAdapterConformance([rawUnadmitted], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:egress_unadmitted/,
    );
  });

  it("rejects Proxy adapters, forged fault handles, and fault-kind spoofing (negative controls)", async () => {
    const base = buildSyntheticSubject();
    if (base.kind !== "email") throw new Error("expected email");

    const proxied: CommunicationsAdapterConformanceSubject = {
      ...base,
      create: async (msg) => {
        const res = await base.create(msg);
        return { ...res, adapter: new Proxy(res.adapter, {}) };
      },
    };
    await expect(runCommunicationsAdapterConformance([proxied], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:proxy_rejected/,
    );

    const forgedSubject = buildSyntheticSubject();
    if (forgedSubject.kind !== "email" || !forgedSubject.certification) throw new Error("expected email");
    const forged: CommunicationsAdapterConformanceSubject = {
      ...forgedSubject,
      certification: {
        ...forgedSubject.certification,
        http5xx: () => {
          const h = makeSyntheticHarness({ kind: "http-failure", status: 503 });
          return { ...h, readFaultLog: () => [{ call: "send", kind: "http-failure" }] };
        },
      },
    };
    await expect(runCommunicationsAdapterConformance([forged], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:invalid_fault_log/,
    );

    const spoofedSubject = buildSyntheticSubject();
    if (spoofedSubject.kind !== "email" || !spoofedSubject.certification) throw new Error("expected email");
    const spoofed: CommunicationsAdapterConformanceSubject = {
      ...spoofedSubject,
      certification: {
        ...spoofedSubject.certification,
        http5xx: () => makeSyntheticHarness({ kind: "http-failure", status: 404 }),
      },
    };
    await expect(runCommunicationsAdapterConformance([spoofed], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:fault_kind_mismatch/,
    );
  });

  it("detects sensitive canary leaks in email outcomes and thrown Error.cause (negative control)", async () => {
    const base = buildSyntheticSubject();
    if (base.kind !== "email") throw new Error("expected email");

    const leakyOutcome: CommunicationsAdapterConformanceSubject = {
      ...base,
      create: () => {
        const adapter = createGuardedEmailTransport({
          providerKind: "leaky",
          policy: makePolicy("sandbox_direct"),
          send: async () => ({
            outcome: {
              ok: false,
              resendId: null,
              httpStatus: 500,
              providerError: `leaked ${encodeURIComponent(CANARY_CREDENTIAL).toLowerCase()}`,
              aborted: false,
            },
            providerResponse: {},
          }),
        });
        return { adapter, readEffectCount: () => 1 };
      },
    };
    await expect(runCommunicationsAdapterConformance([leakyOutcome], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:secret_leak/,
    );

    const leakyThrow: CommunicationsAdapterConformanceSubject = {
      ...base,
      create: () => {
        const adapter = createGuardedEmailTransport({
          providerKind: "leaky_throw",
          policy: makePolicy("sandbox_direct"),
          send: async () => {
            throw new Error("failed", { cause: { token: CANARY_CREDENTIAL } });
          },
        });
        return { adapter, readEffectCount: () => 1 };
      },
    };
    await expect(runCommunicationsAdapterConformance([leakyThrow], { mode: "full" })).rejects.toThrow(
      /COMMUNICATIONS_CONFORMANCE:secret_leak/,
    );
  });
});
