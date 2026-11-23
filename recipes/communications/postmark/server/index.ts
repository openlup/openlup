export {
  POSTMARK_API_ORIGIN,
  POSTMARK_EMAIL_ENDPOINT,
  PostmarkTransportError,
  createPostmarkHttpClient,
  parseRetryAfterSeconds,
  sanitizePostmarkText,
} from "./client-contract.js";
export type {
  PostmarkAttachment,
  PostmarkClient,
  PostmarkEmailHeader,
  PostmarkFetchLike,
  PostmarkHttpClientOptions,
  PostmarkSendEmailInput,
  PostmarkSendResponse,
} from "./client-contract.js";

export {
  POSTMARK_OBSERVATION_EVENTS,
  POSTMARK_PROVIDER_KIND,
  createPostmarkEmailTransport,
  postmarkStaticCapabilities,
  projectPostmarkStaticCapabilities,
} from "./adapter.js";
export type {
  CreatePostmarkEmailTransportOptions,
  PostmarkObservationEvent,
  PostmarkStaticCapabilities,
} from "./adapter.js";

export {
  createPostmarkWebhookHandler,
  verifyPostmarkBasicAuth,
} from "./webhook.js";
export type {
  PostmarkWebhookHandlerOptions,
  PostmarkWebhookRequest,
  PostmarkWebhookResponse,
  VerifyPostmarkBasicAuthInput,
} from "./webhook.js";
