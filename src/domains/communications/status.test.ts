import { describe, expect, it } from "vitest";
import {
  buildEmailSendDedupeKey,
  decideEmailSend,
  isTerminalEmailSendStatus,
  nextEmailSendStatus,
  resendEventKind,
} from "./status.js";

describe("communications email status semantics", () => {
  it("maps Resend webhook event names without provider details leaking out", () => {
    expect(resendEventKind("email.delivered")).toBe("delivered");
    expect(resendEventKind("email.complained")).toBe("complaint");
    expect(resendEventKind("email.unknown")).toBeNull();
  });

  it("maps supported Resend delivery events into send statuses", () => {
    expect(nextEmailSendStatus("sent", "email.delivered")).toBe("delivered");
    expect(nextEmailSendStatus("sent", "email.bounced")).toBe("bounced");
    expect(nextEmailSendStatus("sent", "email.complained")).toBe("complained");
    expect(nextEmailSendStatus("sent", "email.suppressed")).toBe("failed");
  });

  it("does not downgrade delivered or terminal statuses", () => {
    expect(nextEmailSendStatus("delivered", "email.sent")).toBeNull();
    expect(nextEmailSendStatus("bounced", "email.delivered")).toBeNull();
    expect(nextEmailSendStatus("complained", "email.sent")).toBeNull();
    expect(nextEmailSendStatus("skipped", "email.sent")).toBeNull();
    expect(isTerminalEmailSendStatus("failed")).toBe(true);
  });

  it("ignores Resend events that do not update email_sends.status", () => {
    expect(nextEmailSendStatus("sent", "email.opened")).toBeNull();
    expect(nextEmailSendStatus("sent", "email.clicked")).toBeNull();
    expect(nextEmailSendStatus("sent", "email.delivery_delayed")).toBeNull();
  });

  it("builds stable dedupe keys for recipient and template", () => {
    expect(
      buildEmailSendDedupeKey({
        recipientId: " tester-1 ",
        templateSlug: " approved ",
      }),
    ).toBe("email:tester-1:approved");
  });

  it("keeps send decisions pure and retry-friendly", () => {
    expect(
      decideEmailSend({
        sequencePaused: true,
        existingNonFailedMessageId: null,
        templateAvailable: true,
      }),
    ).toEqual({
      outcome: "skip",
      reason: "sequence_paused",
      existingMessageId: null,
    });

    expect(
      decideEmailSend({
        sequencePaused: false,
        existingNonFailedMessageId: "send-1",
        templateAvailable: true,
      }),
    ).toEqual({
      outcome: "skip",
      reason: "already_sent",
      existingMessageId: "send-1",
    });

    expect(
      decideEmailSend({
        sequencePaused: false,
        existingNonFailedMessageId: null,
        templateAvailable: true,
      }),
    ).toEqual({ outcome: "send" });
  });

  it("treats missing templates as a non-provider send decision", () => {
    expect(
      decideEmailSend({
        sequencePaused: false,
        existingNonFailedMessageId: null,
        templateAvailable: false,
      }),
    ).toEqual({
      outcome: "skip",
      reason: "template_unavailable",
      existingMessageId: null,
    });
  });
});
