import { describe, expect, it } from "vitest";
import { evaluateCommunicationPolicy } from "./consentPolicy.js";

describe("evaluateCommunicationPolicy", () => {
  it("blocks newsletter marketing without explicit consent", () => {
    expect(
      evaluateCommunicationPolicy({
        purpose: "marketing_newsletter",
        recipientKind: "lead",
        permission: { state: "unknown" },
      }),
    ).toEqual({ decision: "blocked", reason: "missing_marketing_permission" });
  });

  it("allows launch offers for a granted waitlist permission", () => {
    expect(
      evaluateCommunicationPolicy({
        purpose: "marketing_launch_offer",
        recipientKind: "lead",
        permission: { state: "granted", source: "legacy_waitlist_inferred" },
      }),
    ).toEqual({ decision: "allowed", reason: "marketing_permission_granted" });
  });

  it("blocks tester program mail when the legacy sequence is paused", () => {
    expect(
      evaluateCommunicationPolicy({
        purpose: "tester_program",
        recipientKind: "tester",
        permission: { state: "granted", legacySequencePaused: true },
      }),
    ).toEqual({ decision: "blocked", reason: "sequence_paused" });
  });

  it("keeps admin notifications outside customer marketing consent", () => {
    expect(
      evaluateCommunicationPolicy({
        purpose: "admin_notification",
        recipientKind: "admin_internal",
        permission: { state: "suppressed" },
      }),
    ).toEqual({ decision: "allowed", reason: "admin_notification" });
  });
});
