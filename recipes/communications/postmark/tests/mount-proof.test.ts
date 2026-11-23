import { describe, expect, it } from "vitest";
import {
  classifyEmailSendOutcome,
  createAuthEmailTransport,
  emailTransportMessageId,
  guardAuthEmailTransport,
  guardEmailTransport,
  type EmailObservation,
  type EmailObservationDisposition,
  type EmailObservationPort,
  type EmailSendResult,
  type EmailTransport,
} from "@openlup/platform/communications";
import {
  POSTMARK_EMAIL_ENDPOINT,
  POSTMARK_PROVIDER_KIND,
  createPostmarkEmailTransport,
  createPostmarkHttpClient,
  createPostmarkWebhookHandler,
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

interface InMemorySendRecord {
  readonly sendId: string;
  messageId: string | null;
  status: string;
  observations: (EmailObservation & { readonly sendId: string; readonly messageId: string })[];
}

function createInMemoryEmailObservationStore() {
  const bySendId = new Map<string, InMemorySendRecord>();
  const byMessageId = new Map<string, InMemorySendRecord>();
  const attempts: EmailObservationDisposition[] = [];

  function recordSend(sendId: string, messageId: string | null, status: string): void {
    const rec: InMemorySendRecord = {
      sendId,
      messageId,
      status,
      observations: [],
    };
    bySendId.set(sendId, rec);
    if (messageId) {
      byMessageId.set(messageId, rec);
    }
  }

  const port: EmailObservationPort = {
    async findSend(messageId) {
      const rec = byMessageId.get(messageId);
      return rec ? { id: rec.sendId } : null;
    },
    async applyObservation(observation) {
      const rec = bySendId.get(observation.sendId);
      if (!rec) throw new Error(`missing_send:${observation.sendId}`);
      rec.observations.push(observation);
      rec.status = observation.eventType;
    },
    async recordAttempt(attempt) {
      attempts.push(attempt);
    },
  };

  return { port, recordSend, bySendId, byMessageId, attempts };
}

describe("recipes/communications/postmark — Stage 3 real-flow mount proof", () => {
  it("wires Postmark transport through guardEmailTransport, createAuthEmailTransport, classifyEmailSendOutcome, and authenticated webhook observation", async () => {
    const providerCalls: { readonly url: string; readonly payload: Record<string, unknown> }[] = [];
    let sendSeq = 0;

    const client = createPostmarkHttpClient({
      messageStream: FIXTURE_MESSAGE_STREAM,
      fetchImpl: async (url, init) => {
        expect(url).toBe(POSTMARK_EMAIL_ENDPOINT);
        expect(init?.redirect).toBe("error");
        const payload = JSON.parse(init?.body as string) as Record<string, unknown>;
        providerCalls.push({ url, payload });
        sendSeq += 1;
        return new Response(
          JSON.stringify({
            To: payload["To"],
            SubmittedAt: FIXTURE_SUBMITTED_AT,
            MessageID: `pm-mount-msg-${sendSeq}`,
            ErrorCode: 0,
            Message: "OK",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const transport = createPostmarkEmailTransport({
      policy: makeFixtureEgressPolicy("sandbox_direct"),
      client,
      environmentTagName: FIXTURE_ENVIRONMENT_TAG_NAME,
    });

    // 1. Guard rail admits the transport and sends a transactional email
    const guarded = guardEmailTransport(transport);
    expect(guarded).toBe(transport);
    expect(guarded.providerKind).toBe(POSTMARK_PROVIDER_KIND);

    const store = createInMemoryEmailObservationStore();
    const txResult = await guarded.send(SAMPLE_EMAIL_MESSAGE);
    const txMessageId = emailTransportMessageId(txResult.outcome);
    expect(txMessageId).toBe("pm-mount-msg-1");
    expect(txResult.providerResponse).toEqual({
      message_id: "pm-mount-msg-1",
      error_code: 0,
      submitted_at: FIXTURE_SUBMITTED_AT,
    });
    const txProjection = classifyEmailSendOutcome(txResult.outcome);
    expect(txProjection).toEqual({
      skipReason: null,
      timelineStatus: "sent",
      ledgerStatus: "sent",
      sentAtEligible: true,
      lastErrorCode: null,
    });
    store.recordSend("send-tx-1", txMessageId, txProjection.ledgerStatus);

    // 2. Auth bridge sends an auth email through the same admitted Postmark transport
    const authTransport = guardAuthEmailTransport(createAuthEmailTransport(transport));
    const authResult = await authTransport.send({
      sender: FIXTURE_SENSITIVE_CANARIES.senderEmail,
      recipient: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
      subject: "Verify your email",
      html: "<p>Verify</p>",
      text: "Verify",
    });
    expect(authResult.outcome.ok).toBe(true);
    expect(authResult.outcome.messageId).toBe("pm-mount-msg-2");
    expect(authResult.outcome.egressMode).toBe("sandbox_direct");
    store.recordSend("send-auth-1", authResult.outcome.messageId, "sent");

    // 3. Authenticated Postmark Delivery + Bounce webhooks advance observation state via processEmailObservation
    const webhookHandler = createPostmarkWebhookHandler({
      port: store.port,
      username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
      password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
      receivedAt: () => new Date(FIXTURE_NOW_ISO),
    });
    const authHeader = encodeBasicAuthHeader(
      FIXTURE_SENSITIVE_CANARIES.webhookUsername,
      FIXTURE_SENSITIVE_CANARIES.webhookPassword,
    );

    const deliveryRes = await webhookHandler({
      rawBody: JSON.stringify(
        buildPostmarkWebhookPayload("Delivery", { MessageID: "pm-mount-msg-1" }),
      ),
      headers: { authorization: authHeader },
    });
    expect(deliveryRes).toEqual({ status: 200, body: { success: true } });
    expect(store.bySendId.get("send-tx-1")?.status).toBe("email.delivered");
    expect(store.bySendId.get("send-tx-1")?.observations).toHaveLength(1);

    const bounceRes = await webhookHandler({
      rawBody: JSON.stringify(
        buildPostmarkWebhookPayload("Bounce", { MessageID: "pm-mount-msg-2" }),
      ),
      headers: { authorization: authHeader },
    });
    expect(bounceRes).toEqual({ status: 200, body: { success: true } });
    expect(store.bySendId.get("send-auth-1")?.status).toBe("email.bounced");
    expect(store.attempts).toEqual([
      { outcome: "processed", sendId: "send-tx-1" },
      { outcome: "processed", sendId: "send-auth-1" },
    ]);

    // Verify no secret canaries leaked into persisted records
    const serializedRecords = JSON.stringify([...store.bySendId.values()]);
    expect(serializedRecords).not.toContain(FIXTURE_SENSITIVE_CANARIES.serverToken);
    expect(serializedRecords).not.toContain(FIXTURE_SENSITIVE_CANARIES.webhookPassword);
    expect(serializedRecords).not.toContain(FIXTURE_SENSITIVE_CANARIES.recipientEmail);
    expect(providerCalls).toHaveLength(2);
  });

  it("classifies drop, timeout, and 5xx outcomes through classifyEmailSendOutcome without throwing", async () => {
    const dropTransport = createPostmarkEmailTransport({
      policy: makeFixtureEgressPolicy("drop"),
      client: {
        sendEmail: async () => {
          throw new Error("should_not_call_client_on_drop");
        },
      },
    });
    const dropRes = await guardEmailTransport(dropTransport).send(SAMPLE_EMAIL_MESSAGE);
    expect(classifyEmailSendOutcome(dropRes.outcome)).toEqual({
      skipReason: "egress_suppressed",
      timelineStatus: "skipped",
      ledgerStatus: "skipped",
      sentAtEligible: false,
      lastErrorCode: "egress_suppressed",
    });

    const timeoutTransport = createPostmarkEmailTransport({
      policy: makeFixtureEgressPolicy("sandbox_direct"),
      client: {
        sendEmail: async () => {
          throw new DOMException("aborted", "AbortError");
        },
      },
    });
    const timeoutRes = await guardEmailTransport(timeoutTransport).send(SAMPLE_EMAIL_MESSAGE);
    expect(timeoutRes.outcome.aborted).toBe(true);
    expect(timeoutRes.outcome.httpStatus).toBe(0);
    expect(classifyEmailSendOutcome(timeoutRes.outcome)).toEqual({
      skipReason: null,
      timelineStatus: "delivery_delayed",
      ledgerStatus: "failed",
      sentAtEligible: false,
      lastErrorCode: "provider_request_aborted",
    });

    const outageTransport = createPostmarkEmailTransport({
      policy: makeFixtureEgressPolicy("sandbox_direct"),
      client: createPostmarkHttpClient({
        fetchImpl: async () => new Response("Service Unavailable", { status: 503 }),
      }),
    });
    const outageRes = await guardEmailTransport(outageTransport).send(SAMPLE_EMAIL_MESSAGE);
    expect(outageRes.outcome.httpStatus).toBe(503);
    expect(classifyEmailSendOutcome(outageRes.outcome)).toEqual({
      skipReason: null,
      timelineStatus: "failed",
      ledgerStatus: "failed",
      sentAtEligible: false,
      lastErrorCode: "postmark_http_503",
    });
  });

  it("negative controls: raw unadmitted transport is rejected and unauthenticated webhook produces 0 observation mutations", async () => {
    // NC1: Raw unadmitted transport rejected by guardEmailTransport with 0 provider calls
    let rawCalls = 0;
    const rawTransport: EmailTransport = {
      providerKind: POSTMARK_PROVIDER_KIND,
      async send(): Promise<EmailSendResult> {
        rawCalls += 1;
        return {
          outcome: { ok: true, resendId: "pm-unadmitted", httpStatus: 200, providerError: null, aborted: false },
          providerResponse: { message_id: "pm-unadmitted", error_code: 0, submitted_at: FIXTURE_SUBMITTED_AT },
        };
      },
    };

    const guardedRaw = guardEmailTransport(rawTransport);
    const blocked = await guardedRaw.send(SAMPLE_EMAIL_MESSAGE);
    expect(blocked).toEqual({
      outcome: {
        ok: false,
        resendId: null,
        httpStatus: 0,
        providerError: "email_egress_unadmitted",
        aborted: false,
      },
      providerResponse: { egress_reason: "email_egress_unadmitted" },
    });
    expect(rawCalls).toBe(0);

    // NC2: Unauthenticated webhook returns 401 with 0 observation mutations
    const store = createInMemoryEmailObservationStore();
    store.recordSend("send-nc-1", "pm-mount-msg-nc", "sent");

    const webhookHandler = createPostmarkWebhookHandler({
      port: store.port,
      username: FIXTURE_SENSITIVE_CANARIES.webhookUsername,
      password: FIXTURE_SENSITIVE_CANARIES.webhookPassword,
    });
    const unauthRes = await webhookHandler({
      rawBody: JSON.stringify(
        buildPostmarkWebhookPayload("Delivery", { MessageID: "pm-mount-msg-nc" }),
      ),
      headers: {},
    });
    expect(unauthRes).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(store.bySendId.get("send-nc-1")?.status).toBe("sent");
    expect(store.bySendId.get("send-nc-1")?.observations).toHaveLength(0);
    expect(store.attempts).toHaveLength(0);
  });
});
