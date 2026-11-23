import type { EmailEgressPolicy, EmailMessage } from "@openlup/platform/communications";

export const FIXTURE_NOW_ISO = "2000-04-15T10:30:00.000Z";
export const FIXTURE_SUBMITTED_AT = "2000-04-15T10:30:00.125-05:00";

export const FIXTURE_SENSITIVE_CANARIES = Object.freeze({
  serverToken: "postmark-canary-marker/alpha+01",
  webhookUsername: "postmark-hook-user-canary",
  webhookPassword: "postmark-hook-pass-canary/01",
  recipientEmail: "customer.canary@example.invalid",
  sinkEmail: "sink.canary@example.invalid",
  senderEmail: "store@example.invalid",
});

export const FIXTURE_ENVIRONMENT_TAG_NAME = "openlup_env";
export const FIXTURE_MESSAGE_STREAM = "outbound";

export const SAMPLE_EMAIL_MESSAGE: EmailMessage = Object.freeze({
  from: FIXTURE_SENSITIVE_CANARIES.senderEmail,
  to: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
  subject: "Order confirmed",
  html: "<p>Your order is confirmed.</p>",
  text: "Your order is confirmed.",
  replyTo: "support@example.invalid",
  idempotencyKey: "pm-idem-001",
});

export function makeFixtureEgressPolicy(
  mode: "production" | "sandbox_direct" | "sandbox_sink" | "drop" | "blocked",
): EmailEgressPolicy {
  return (intendedRecipient: string) => {
    if (mode === "drop") {
      return { mode: "drop", reason: "test_suppressed" };
    }
    if (mode === "blocked") {
      return { mode: "blocked", reason: "test_blocked" };
    }
    if (mode === "sandbox_sink") {
      return {
        mode: "sandbox_sink",
        reason: "test_sink",
        intendedRecipient,
        recipient: FIXTURE_SENSITIVE_CANARIES.sinkEmail,
        credential: FIXTURE_SENSITIVE_CANARIES.serverToken,
        environmentTag: "non_production",
      };
    }
    if (mode === "production") {
      return {
        mode: "production",
        reason: "test_production",
        intendedRecipient,
        recipient: intendedRecipient,
        credential: FIXTURE_SENSITIVE_CANARIES.serverToken,
        environmentTag: "production",
      };
    }
    return {
      mode: "sandbox_direct",
      reason: "test_sandbox",
      intendedRecipient,
      recipient: intendedRecipient,
      credential: FIXTURE_SENSITIVE_CANARIES.serverToken,
      environmentTag: "non_production",
    };
  };
}

export function encodeBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export function buildPostmarkWebhookPayload(
  recordType:
    | "Delivery"
    | "Bounce"
    | "SpamComplaint"
    | "Open"
    | "Click"
    | "SubscriptionChange",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    RecordType: recordType,
    MessageID: "pm-msg-001",
    MessageStream: FIXTURE_MESSAGE_STREAM,
    Tag: "order-confirmation",
  };
  switch (recordType) {
    case "Delivery":
      return { ...base, DeliveredAt: FIXTURE_NOW_ISO, ...overrides };
    case "Bounce":
      return {
        ...base,
        Type: "HardBounce",
        TypeCode: 1,
        Inactive: true,
        BouncedAt: FIXTURE_NOW_ISO,
        ...overrides,
      };
    case "SpamComplaint":
      return {
        ...base,
        Type: "SpamComplaint",
        TypeCode: 512,
        BouncedAt: FIXTURE_NOW_ISO,
        ...overrides,
      };
    case "Open":
      return { ...base, ReceivedAt: FIXTURE_NOW_ISO, ...overrides };
    case "Click":
      return {
        ...base,
        ReceivedAt: FIXTURE_NOW_ISO,
        OriginalLink: "https://store.example.invalid/orders/ord-1",
        ...overrides,
      };
    case "SubscriptionChange":
      return {
        ...base,
        ChangedAt: FIXTURE_NOW_ISO,
        SuppressSending: true,
        SuppressionReason: "HardBounce",
        Origin: "Recipient",
        ...overrides,
      };
  }
}
