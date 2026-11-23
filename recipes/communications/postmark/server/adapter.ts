import {
  createGuardedEmailTransport,
  type EmailEgressContext,
  type EmailEgressPolicy,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
} from "@openlup/platform/communications";
import {
  PostmarkTransportError,
  sanitizePostmarkText,
  type PostmarkAttachment,
  type PostmarkClient,
  type PostmarkEmailHeader,
  type PostmarkSendResponse,
} from "./client-contract.js";

export const POSTMARK_PROVIDER_KIND = "postmark" as const;

export const POSTMARK_OBSERVATION_EVENTS = Object.freeze([
  "Delivery",
  "Bounce",
  "SpamComplaint",
  "Open",
  "Click",
  "SubscriptionChange",
] as const);

export type PostmarkObservationEvent = (typeof POSTMARK_OBSERVATION_EVENTS)[number];

export interface PostmarkStaticCapabilities {
  readonly providerKind: typeof POSTMARK_PROVIDER_KIND;
  readonly egressGuarded: true;
  readonly webhookAuth: "basic-auth";
  readonly supportsMessageStream: true;
  readonly supportsObservationEvents: readonly PostmarkObservationEvent[];
}

export const postmarkStaticCapabilities: PostmarkStaticCapabilities = Object.freeze({
  providerKind: POSTMARK_PROVIDER_KIND,
  egressGuarded: true,
  webhookAuth: "basic-auth",
  supportsMessageStream: true,
  supportsObservationEvents: POSTMARK_OBSERVATION_EVENTS,
});

/** Projects the serializable static capability descriptor matched against recipe.json. */
export function projectPostmarkStaticCapabilities(): PostmarkStaticCapabilities {
  return {
    providerKind: postmarkStaticCapabilities.providerKind,
    egressGuarded: postmarkStaticCapabilities.egressGuarded,
    webhookAuth: postmarkStaticCapabilities.webhookAuth,
    supportsMessageStream: postmarkStaticCapabilities.supportsMessageStream,
    supportsObservationEvents: [...postmarkStaticCapabilities.supportsObservationEvents],
  };
}

export interface CreatePostmarkEmailTransportOptions {
  readonly policy: EmailEgressPolicy;
  readonly client: PostmarkClient;
  readonly environmentTagName?: string;
  readonly messageStream?: string;
}

function mapHttpErrorCode(httpStatus: number): string {
  if (httpStatus === 401 || httpStatus === 403) return "auth_failed";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 422) return "validation_failed";
  if (httpStatus >= 500) return "provider_error";
  return "http_error";
}

function mapSuccessResponse(
  response: PostmarkSendResponse,
  context: Readonly<EmailEgressContext>,
): EmailSendResult {
  const messageId =
    typeof response.MessageID === "string" && response.MessageID.trim().length > 0
      ? response.MessageID.trim()
      : null;
  const errorCode =
    typeof response.ErrorCode === "number" && Number.isFinite(response.ErrorCode)
      ? response.ErrorCode
      : 0;
  const submittedAt =
    typeof response.SubmittedAt === "string" && response.SubmittedAt.trim().length > 0
      ? response.SubmittedAt.trim()
      : null;

  if (errorCode !== 0) {
    const sanitizedMessage =
      typeof response.Message === "string" && response.Message.trim().length > 0
        ? sanitizePostmarkText(response.Message, [context.credential])
        : "";
    return {
      outcome: {
        ok: false,
        resendId: null,
        httpStatus: 200,
        providerError: sanitizedMessage || `postmark_error_${errorCode}`,
        providerErrorCode: String(errorCode),
        aborted: false,
      },
      providerResponse: {
        message_id: null,
        error_code: errorCode,
        submitted_at: submittedAt,
      },
    };
  }

  return {
    outcome: {
      ok: true,
      resendId: messageId,
      httpStatus: 200,
      providerError: null,
      providerErrorCode: null,
      aborted: false,
    },
    providerResponse: {
      message_id: messageId,
      error_code: errorCode,
      submitted_at: submittedAt,
    },
  };
}

function mapFailureError(error: unknown, signal?: AbortSignal): EmailSendResult {
  if (error instanceof PostmarkTransportError) {
    if (error.aborted) {
      return {
        outcome: {
          ok: false,
          resendId: null,
          httpStatus: 0,
          providerError: "postmark_timeout",
          providerErrorCode: "timeout",
          aborted: true,
        },
        providerResponse: {
          message_id: null,
          error_code: null,
          submitted_at: null,
        },
      };
    }

    if (error.httpStatus > 0) {
      return {
        outcome: {
          ok: false,
          resendId: null,
          httpStatus: error.httpStatus,
          providerError: error.code,
          providerErrorCode: mapHttpErrorCode(error.httpStatus),
          aborted: false,
        },
        providerResponse: {
          message_id: null,
          error_code: error.errorCode,
          submitted_at: null,
          ...(error.retryAfterSeconds !== null
            ? { retry_after_seconds: error.retryAfterSeconds }
            : {}),
        },
      };
    }

    return {
      outcome: {
        ok: false,
        resendId: null,
        httpStatus: 0,
        providerError: error.code,
        providerErrorCode: "transport_error",
        aborted: false,
      },
      providerResponse: {
        message_id: null,
        error_code: error.errorCode,
        submitted_at: null,
      },
    };
  }

  const aborted =
    signal?.aborted === true
    || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));

  return {
    outcome: {
      ok: false,
      resendId: null,
      httpStatus: 0,
      providerError: aborted ? "postmark_timeout" : "postmark_transport_error",
      providerErrorCode: aborted ? "timeout" : "transport_error",
      aborted,
    },
    providerResponse: {
      message_id: null,
      error_code: null,
      submitted_at: null,
    },
  };
}

/**
 * Constructs a policy-guarded `EmailTransport` backed by Postmark's Transactional Email API.
 * Admitted by `guardEmailTransport` via `createGuardedEmailTransport`.
 */
export function createPostmarkEmailTransport(
  options: CreatePostmarkEmailTransportOptions,
): EmailTransport {
  if (!options.client || typeof options.client.sendEmail !== "function") {
    throw new TypeError("createPostmarkEmailTransport requires a PostmarkClient");
  }
  const environmentTagName = options.environmentTagName ?? "openlup_env";
  if (typeof environmentTagName !== "string" || environmentTagName.trim().length === 0) {
    throw new RangeError("createPostmarkEmailTransport environmentTagName must be non-empty");
  }

  return createGuardedEmailTransport({
    providerKind: POSTMARK_PROVIDER_KIND,
    policy: options.policy,
    async send(message: EmailMessage, context: Readonly<EmailEgressContext>): Promise<EmailSendResult> {
      const metadata: Record<string, string> = {
        [environmentTagName]: context.environmentTag,
      };
      if (message.idempotencyKey !== undefined) {
        metadata["idempotency_key"] = message.idempotencyKey;
      }
      if (context.mode === "sandbox_sink") {
        metadata["original_recipient"] = context.intendedRecipient;
      }

      const headers: PostmarkEmailHeader[] | undefined =
        context.mode === "sandbox_sink"
          ? [{ Name: "X-Original-Recipient", Value: context.intendedRecipient }]
          : undefined;

      const attachments: PostmarkAttachment[] | undefined =
        message.attachments && message.attachments.length > 0
          ? message.attachments.map((att) => ({
              Name: att.filename,
              Content: att.content,
              ContentType: "application/octet-stream",
            }))
          : undefined;

      try {
        const response = await options.client.sendEmail({
          serverToken: context.credential,
          from: message.from,
          to: context.recipient,
          subject: message.subject,
          htmlBody: message.html,
          ...(message.text !== undefined ? { textBody: message.text } : {}),
          ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
          ...(options.messageStream !== undefined ? { messageStream: options.messageStream } : {}),
          metadata,
          ...(headers !== undefined ? { headers } : {}),
          ...(attachments !== undefined ? { attachments } : {}),
          ...(message.signal !== undefined ? { signal: message.signal } : {}),
        });
        return mapSuccessResponse(response, context);
      } catch (error) {
        return mapFailureError(error, message.signal);
      }
    },
  });
}
