# server/infra/email - provider-neutral email transport

Status: source-of-truth
Verified against `0dc20d72` (2026-09-04) - scope: `emailTransport.ts`,
`emailNotificationControl.ts`, every consumer of `EmailTransport` and
`postResendEmail` found by grep, and the render-parity test named below. No mail
was sent and no provider account was inspected.

This is the OSS swap point for outbound email. Everything above this boundary
talks to the `EmailTransport` interface rather than to a named provider.

## Contract

`emailTransport.ts` defines:

- `EmailMessage` - `{ from, to, subject, html, text?, replyTo?, idempotencyKey?,
  attachments?, signal? }`. Attachments accept Base64 `{ filename, content }`
  values only; remote URLs and filesystem paths are deliberately outside this
  boundary.
- `EmailTransport` - `{ providerKind, send(message) }`. `providerKind` is the
  stable tag ledgers and observability record.
- `EmailSendOutcome` and `EmailSendResult` - the result types. They are neutral
  *aliases*, not neutral *shapes*: both are re-exports of the concrete client's
  `ResendEmailSendOutcome` / `ResendEmailPostResult`, and the outcome still
  carries a `resendId` field. Two helpers exist precisely because of that leak -
  `emailTransportMessageId()` reads the identifier at the boundary, and
  `emailTransportLedgerIdentifier()` writes it back onto the current source
  schema's legacy `resend_id` column. A fork replacing the provider keeps those
  two field names or migrates the ledger; nothing else above the seam names the
  vendor.
- `failedEmailTransportResult()` - the canonical terminal shape when `send`
  throws.
- `classifyEmailSendOutcome()` / `withEmailSendSkipReason()` - map an outcome to
  a neutral `skipReason` of `admin_disabled` or `egress_suppressed`.

Implementations:

- `createResendTransport({ apiKey, env })` - the Resend-backed reference
  adapter. This is a source-composition description, not evidence that a
  provider has been selected or deployed. All provider specifics (endpoint,
  authorization header, response parsing) and the fail-closed egress gateway
  stay isolated in `../resend/resendEmailClient.ts`; this transport only forwards
  the message. `createEmailTransport` is an alias for it, and is the name the
  composition roots use.
- `createInMemoryEmailTransport()` - a non-provider reference transport. Captures
  sends in a readable `sent` array and makes no network call.
  `emailTransport.test.ts` uses it to prove a consumer can send with zero
  provider references - the same starting point a fork uses before writing its
  own SES or SMTP adapter.

`emailNotificationControl.ts` sits beside the transport and owns the
administrative kill switch (`EmailNotificationControlPort`,
`EMAIL_NOTIFICATION_ADMIN_DISABLED`). It is checked before a send, not inside the
transport.

## To run on another provider

Implement `EmailTransport.send` for your provider, mirroring
`createResendTransport`, and construct it where `createEmailTransport` is called
today. Nothing above this seam needs to change.

## Current source wiring

Every Node email port already depends on the interface; none of them imports
`postResendEmail`. Two ports require an injected transport and have no provider
default at all: `accountingInvoiceDeliveryPort.ts` and
`feedbackUploadNotificationPort.ts`. Five accept an optional `transport` and fall
back to `createResendTransport({ apiKey, env: process.env })` when the caller
omits it: `marketingEmailPort.ts`, `subscriptionDunningEmailPort.ts`,
`subscriptionDunningScanEmailPort.ts`, `subscriptionLifecycleEmailPort.ts` and
`transactionalEmailPort.ts`. Composition roots that already inject explicitly
live in `server/runtime/**` and `server/adapters/supabase/**`. This is an
inventory of current source wiring; it makes no claim about a mounted or
deployed composition.

Removing the five per-port defaults, so the provider is chosen once at
composition, is the remaining mechanical step. It is a small change and nothing
depends on it staying undone.

## Scope

This is the send seam only. This deployment ships one runtime: the Deno half
retired with the Edge tree on 2026-09-05 and no cross-runtime parity test
survives. An adopter that does support two runtimes must provide its own
conformance coverage for each shipped locale.

## Known non-neutrality

The `resendId` / `resend_id` identifier field names above, and the fact that
`DEFAULT_EMAIL_PROVIDER_KIND` is a vendor name, are the residue this seam has not
yet removed. They are data field names, not behaviour: a replacement transport
sets its own `providerKind` and fills `resendId` with its own message id.
