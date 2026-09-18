import { describe, expect, it } from "vitest";
import {
  PAYMENT_FAILURE_CLASSES,
  PAYMENT_FAILURE_CUSTOMER_CAUSES,
  PAYMENT_FAILURE_HINTS,
  PAYMENT_RETRY_ADVICE_CODES,
  SCHEME_RETRY_ATTEMPT_CEILING,
  SCHEME_RETRY_WINDOW_DAYS,
  classifyPaymentFailure,
  customerCauseForFailureClass,
  failureClassDecision,
  isPaymentRetryAdviceCode,
  withinSchemeRetryCeiling,
  type PaymentFailureClass,
  type PaymentFailureClassificationSource,
  type PaymentFailureDecision,
  type PaymentFailureEvidence,
  type PaymentFailureHint,
} from "../src/payment/index.js";

type Case = {
  name: string;
  evidence: PaymentFailureEvidence;
  declineCodeHints?: Readonly<Record<string, readonly PaymentFailureHint[]>>;
  failureClass: PaymentFailureClass;
  decidedBy: PaymentFailureClassificationSource;
};

function classify(testCase: Case) {
  return classifyPaymentFailure(
    testCase.evidence,
    testCase.declineCodeHints ? { declineCodeHints: testCase.declineCodeHints } : {},
  );
}

const adviceCases: Case[] = [
  {
    name: "issuer says never again",
    evidence: { adviceCode: "do_not_try_again" },
    failureClass: "hard_do_not_retry",
    decidedBy: "advice_code",
  },
  {
    name: "issuer says fix the submitted data",
    evidence: { adviceCode: "confirm_card_data" },
    failureClass: "fix_and_retry_customer_action",
    decidedBy: "advice_code",
  },
  {
    name: "issuer says wait and retry",
    evidence: { adviceCode: "try_again_later" },
    failureClass: "soft_retryable",
    decidedBy: "advice_code",
  },
];

const hintCases: Case[] = [
  {
    name: "dead credential",
    evidence: { neutralReasonHints: ["credentialDead"] },
    failureClass: "hard_do_not_retry",
    decidedBy: "neutral_hint",
  },
  {
    name: "stored reference no longer honoured",
    evidence: { neutralReasonHints: ["mandateUnsupported"] },
    failureClass: "mandate_dead",
    decidedBy: "neutral_hint",
  },
  {
    name: "authentication demanded",
    evidence: { neutralReasonHints: ["authenticationRequired"] },
    failureClass: "sca_required",
    decidedBy: "neutral_hint",
  },
  {
    name: "submitted value rejected",
    evidence: { neutralReasonHints: ["dataInvalid"] },
    failureClass: "fix_and_retry_customer_action",
    decidedBy: "neutral_hint",
  },
  {
    name: "limit hit",
    evidence: { neutralReasonHints: ["limitExceeded"] },
    failureClass: "soft_retry_delayed",
    decidedBy: "neutral_hint",
  },
  {
    name: "ordinary temporary refusal",
    evidence: { neutralReasonHints: ["transient"] },
    failureClass: "soft_retryable",
    decidedBy: "neutral_hint",
  },
];

const reasonKeyCases: Case[] = [
  {
    name: "off-session authentication demand",
    evidence: { failureReasonKey: "off_session_sca_required" },
    failureClass: "sca_required",
    decidedBy: "failure_reason_key",
  },
  {
    name: "bare refusal carries no issuer verdict",
    evidence: { failureReasonKey: "provider_declined" },
    failureClass: "indeterminate",
    decidedBy: "failure_reason_key",
  },
  {
    name: "execution-rail failure carries no issuer verdict",
    evidence: { failureReasonKey: "provider_failed" },
    failureClass: "indeterminate",
    decidedBy: "failure_reason_key",
  },
  {
    name: "callback-rail failure carries no issuer verdict",
    evidence: { failureReasonKey: "provider_webhook_failed" },
    failureClass: "indeterminate",
    decidedBy: "failure_reason_key",
  },
  {
    name: "ambiguous execution outcome",
    evidence: { failureReasonKey: "provider_execution_indeterminate" },
    failureClass: "indeterminate",
    decidedBy: "failure_reason_key",
  },
  {
    name: "the payer withdrew the stored authorization",
    evidence: { failureReasonKey: "payment_method_revoked" },
    failureClass: "hard_do_not_retry",
    decidedBy: "failure_reason_key",
  },
  {
    name: "the stored method needs the payer present",
    evidence: { failureReasonKey: "payment_method_requires_action" },
    failureClass: "sca_required",
    decidedBy: "failure_reason_key",
  },
  {
    name: "nothing usable is stored",
    evidence: { failureReasonKey: "missing_provider_method_ref" },
    failureClass: "fix_and_retry_customer_action",
    decidedBy: "failure_reason_key",
  },
  {
    name: "what is stored failed its integrity read",
    evidence: { failureReasonKey: "payment_method_invalid" },
    failureClass: "fix_and_retry_customer_action",
    decidedBy: "failure_reason_key",
  },
  {
    // The kernel embeds no scheme vocabulary, so a vendor-prefixed preflight
    // reason decides nothing here and waits for its adapter to assert a hint.
    // The prefix below is fictional on purpose: the property under test is the
    // SHAPE (an adapter-owned key the kernel never mapped), and naming a real
    // adapter would import that adapter's vocabulary into the neutral kernel.
    name: "a vendor-prefixed preflight reason decides nothing in the kernel",
    evidence: { failureReasonKey: "acmerail_recurring_requires_model_o" },
    failureClass: "indeterminate",
    decidedBy: "default",
  },
];

const precedenceCases: Case[] = [
  {
    name: "advice outranks a contradicting hint and reason key",
    evidence: {
      adviceCode: "do_not_try_again",
      neutralReasonHints: ["transient"],
      failureReasonKey: "off_session_sca_required",
    },
    failureClass: "hard_do_not_retry",
    decidedBy: "advice_code",
  },
  {
    name: "advice outranks a hint reached through the caller's decline table",
    evidence: { adviceCode: "try_again_later", declineCode: "code_alpha" },
    declineCodeHints: { code_alpha: ["credentialDead"] },
    failureClass: "soft_retryable",
    decidedBy: "advice_code",
  },
  {
    name: "an unrecognized advice value decides nothing and falls through",
    evidence: { adviceCode: "advice_not_in_the_vocabulary", neutralReasonHints: ["transient"] },
    failureClass: "soft_retryable",
    decidedBy: "neutral_hint",
  },
  {
    name: "a hint outranks a contradicting reason key",
    evidence: { neutralReasonHints: ["dataInvalid"], failureReasonKey: "off_session_sca_required" },
    failureClass: "fix_and_retry_customer_action",
    decidedBy: "neutral_hint",
  },
  {
    name: "a decline code resolves through the caller's table and outranks the reason key",
    evidence: { declineCode: "code_beta", failureReasonKey: "provider_declined" },
    declineCodeHints: { code_beta: ["mandateUnsupported"] },
    failureClass: "mandate_dead",
    decidedBy: "neutral_hint",
  },
  {
    name: "a decline code with no caller table contributes nothing",
    evidence: { declineCode: "code_gamma", failureReasonKey: "off_session_sca_required" },
    failureClass: "sca_required",
    decidedBy: "failure_reason_key",
  },
  {
    name: "a decline code absent from the caller table contributes nothing",
    evidence: { declineCode: "code_delta", failureReasonKey: "provider_failed" },
    declineCodeHints: { code_beta: ["credentialDead"] },
    failureClass: "indeterminate",
    decidedBy: "failure_reason_key",
  },
];

const unknownCases: Case[] = [
  {
    name: "no evidence at all",
    evidence: {},
    failureClass: "indeterminate",
    decidedBy: "default",
  },
  {
    name: "an unrecognized reason key",
    evidence: { failureReasonKey: "reason_key_not_in_the_table" },
    failureClass: "indeterminate",
    decidedBy: "default",
  },
  {
    name: "an unrecognized advice value alone",
    evidence: { adviceCode: "advice_not_in_the_vocabulary" },
    failureClass: "indeterminate",
    decidedBy: "default",
  },
  {
    name: "an empty hint list",
    evidence: { neutralReasonHints: [] },
    failureClass: "indeterminate",
    decidedBy: "default",
  },
  {
    name: "an inherited key is not a decline-code entry",
    evidence: { declineCode: "constructor" },
    declineCodeHints: { code_beta: ["credentialDead"] },
    failureClass: "indeterminate",
    decidedBy: "default",
  },
  {
    name: "an inherited key is not a reason-key entry",
    evidence: { failureReasonKey: "toString" },
    failureClass: "indeterminate",
    decidedBy: "default",
  },
];

const allCases = [
  ...adviceCases,
  ...hintCases,
  ...reasonKeyCases,
  ...precedenceCases,
  ...unknownCases,
];

describe("payment failure taxonomy", () => {
  it.each(allCases)("classifies $name", (testCase) => {
    expect(classify(testCase)).toEqual({
      failureClass: testCase.failureClass,
      decidedBy: testCase.decidedBy,
    });
  });

  it("reaches every declared class from evidence", () => {
    const reached = new Set(allCases.map((testCase) => classify(testCase).failureClass));
    expect([...reached].sort()).toEqual([...PAYMENT_FAILURE_CLASSES].sort());
  });

  it("covers every declared advice code and every declared hint", () => {
    expect(adviceCases.map((testCase) => testCase.evidence.adviceCode).sort())
      .toEqual([...PAYMENT_RETRY_ADVICE_CODES].sort());
    expect(hintCases.flatMap((testCase) => [...(testCase.evidence.neutralReasonHints ?? [])]).sort())
      .toEqual([...PAYMENT_FAILURE_HINTS].sort());
  });

  it("resolves competing hints strictest-first in declaration order", () => {
    for (const [index, stricter] of PAYMENT_FAILURE_HINTS.entries()) {
      for (const weaker of PAYMENT_FAILURE_HINTS.slice(index + 1)) {
        expect(classifyPaymentFailure({ neutralReasonHints: [weaker, stricter] }))
          .toEqual(classifyPaymentFailure({ neutralReasonHints: [stricter] }));
      }
    }
  });

  it("merges directly asserted hints with hints reached through a decline code", () => {
    expect(
      classifyPaymentFailure(
        { declineCode: "code_alpha", neutralReasonHints: ["transient"] },
        { declineCodeHints: { code_alpha: ["credentialDead"] } },
      ),
    ).toEqual({ failureClass: "hard_do_not_retry", decidedBy: "neutral_hint" });
  });

  it("freezes the classification it returns", () => {
    const classification = classifyPaymentFailure({ failureReasonKey: "provider_declined" });
    expect(Object.isFrozen(classification)).toBe(true);
    expect(() => {
      (classification as { failureClass: PaymentFailureClass }).failureClass = "soft_retryable";
    }).toThrow(TypeError);
  });

  it("recognizes exactly the declared advice vocabulary", () => {
    for (const code of PAYMENT_RETRY_ADVICE_CODES) expect(isPaymentRetryAdviceCode(code)).toBe(true);
    expect(isPaymentRetryAdviceCode("do_not_try_again_please")).toBe(false);
    expect(isPaymentRetryAdviceCode("")).toBe(false);
  });
});

const decisionTable: Array<[PaymentFailureClass, PaymentFailureDecision]> = [
  [
    "hard_do_not_retry",
    {
      retryAllowed: false,
      retryProfile: "none",
      customerActionRequired: true,
      methodReplacementRequired: true,
    },
  ],
  [
    "mandate_dead",
    {
      retryAllowed: false,
      retryProfile: "none",
      customerActionRequired: true,
      methodReplacementRequired: true,
    },
  ],
  [
    "sca_required",
    {
      retryAllowed: true,
      retryProfile: "on_session_only",
      customerActionRequired: true,
      methodReplacementRequired: false,
    },
  ],
  [
    "fix_and_retry_customer_action",
    {
      retryAllowed: false,
      retryProfile: "none",
      customerActionRequired: true,
      methodReplacementRequired: false,
    },
  ],
  [
    "soft_retry_delayed",
    {
      retryAllowed: true,
      retryProfile: "delayed",
      customerActionRequired: false,
      methodReplacementRequired: false,
    },
  ],
  [
    "soft_retryable",
    {
      retryAllowed: true,
      retryProfile: "standard",
      customerActionRequired: false,
      methodReplacementRequired: false,
    },
  ],
  [
    "indeterminate",
    {
      retryAllowed: true,
      retryProfile: "standard",
      customerActionRequired: false,
      methodReplacementRequired: false,
    },
  ],
];

describe("payment failure class decisions", () => {
  it("pins a decision for exactly the declared classes", () => {
    expect(decisionTable.map(([failureClass]) => failureClass).sort())
      .toEqual([...PAYMENT_FAILURE_CLASSES].sort());
  });

  it.each(decisionTable)("pins the decision for %s", (failureClass, expected) => {
    expect(failureClassDecision(failureClass)).toEqual(expected);
  });

  it.each(decisionTable)("freezes the decision for %s", (failureClass) => {
    const decision = failureClassDecision(failureClass);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => {
      (decision as { retryAllowed: boolean }).retryAllowed = true;
    }).toThrow(TypeError);
    expect(failureClassDecision(failureClass)).toEqual(decision);
  });

  it("never allows an unattended retry for a class that demands a replacement method", () => {
    for (const [, decision] of decisionTable) {
      if (decision.methodReplacementRequired) expect(decision.retryAllowed).toBe(false);
      if (!decision.retryAllowed) expect(decision.retryProfile).toBe("none");
      if (decision.retryProfile === "on_session_only") {
        expect(decision.customerActionRequired).toBe(true);
      }
    }
  });
});

describe("scheme retry ceiling", () => {
  it("pins the ceiling any later cadence must respect", () => {
    expect(SCHEME_RETRY_ATTEMPT_CEILING).toBe(15);
    expect(SCHEME_RETRY_WINDOW_DAYS).toBe(30);
  });

  it.each([
    [1, 30, true],
    [14, 30, true],
    [15, 30, true],
    [16, 30, false],
    [15, 1, true],
    [15, 29, true],
    [15, 31, false],
    [1, 31, false],
    [0, 30, false],
    [-1, 30, false],
    [15, 0, false],
    [15, -1, false],
    [1.5, 30, false],
    [15, 30.5, false],
    [Number.NaN, 30, false],
    [Number.POSITIVE_INFINITY, 30, false],
    [15, Number.NaN, false],
  ])("answers %s attempts over %s days as %s", (attemptCount, windowDays, expected) => {
    expect(withinSchemeRetryCeiling(attemptCount, windowDays)).toBe(expected);
  });
});

describe("customer cause vocabulary", () => {
  it("answers every class, so a new class cannot default into a sentence", () => {
    const causes = PAYMENT_FAILURE_CLASSES.map((failureClass) => [
      failureClass,
      customerCauseForFailureClass(failureClass),
    ]);
    expect(causes).toEqual([
      ["hard_do_not_retry", "method_dead"],
      ["mandate_dead", "method_cannot_recur"],
      ["sca_required", "needs_confirmation"],
      ["fix_and_retry_customer_action", "method_data_invalid"],
      ["soft_retry_delayed", "unknown"],
      ["soft_retryable", "unknown"],
      ["indeterminate", "unknown"],
    ]);
  });

  it("says nothing about a class it was never given", () => {
    // The three ways a persisted column reaches this function without a verdict.
    expect(customerCauseForFailureClass(null)).toBe("unknown");
    expect(customerCauseForFailureClass(undefined)).toBe("unknown");
    expect(customerCauseForFailureClass("a_class_from_a_newer_deployment")).toBe("unknown");
  });

  it("is not reachable through prototype keys", () => {
    expect(customerCauseForFailureClass("toString")).toBe("unknown");
    expect(customerCauseForFailureClass("constructor")).toBe("unknown");
  });

  it("keeps `method_missing` unreachable from any failure class", () => {
    // It belongs to the pre-renewal rails, which look at an absent method rather
    // than a refusal. A class producing it would mean a refusal happened on a
    // method we are simultaneously claiming does not exist.
    const fromClasses = PAYMENT_FAILURE_CLASSES.map(customerCauseForFailureClass);
    expect(fromClasses).not.toContain("method_missing");
    expect(PAYMENT_FAILURE_CUSTOMER_CAUSES).toContain("method_missing");
  });
});
