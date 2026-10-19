# server/infra/email - provider-neutral email transport

Status: development-preview source contract.
M04 B1 verification uses the package transport conformance, neutral caller
transcripts and `emailEgressReference.test.ts` wire witnesses. These use synthetic
senders and intercepted HTTP; no mail is sent and no provider account is inspected.

This is the OSS swap point for outbound email. Everything above this boundary
talks to the `EmailTransport` interface rather than to a named provider.

## Contract

`emailTransport.ts` defines:

- `EmailMessage` - `{ from, to, subject, html, text?, replyTo?, idempotencyKey?,
  attachments?, signal? }`. Attachments accept Base64 `{ filename, content }`
  values only; remote URLs and filesystem paths are deliberately outside this
  boundary.
- `EmailTransport` - `{ providerKind, send(message) }`. `providerKind` is the
  stable tag ledgers and observability record. Injection requires package-owned
  admission; the tag does not authorize network effects.
- `EmailSendOutcome` and `EmailSendResult` - the result types. They are neutral
  package shapes retain a legacy `resendId` field for reference compatibility. Two helpers exist precisely because of that leak -
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
  The package `transportConformance.test.ts` and egress tests retain the complete
  ordered envelope/result and zero-network witnesses.

`emailNotificationControl.ts` sits beside the transport and owns the
administrative kill switch (`EmailNotificationControlPort`,
`EMAIL_NOTIFICATION_ADMIN_DISABLED`). It is checked before a send, not inside the
transport.

## To run on another provider

Compose a new sender with the package `createGuardedEmailTransport` constructor.
Supply a fresh explicit policy and consume its admitted recipient, credential and
environment tag in the concrete sender. Unknown or incomplete policy refuses
before sender entry; `drop` suppresses and `blocked` fails. Raw injected objects
are refused even if their provider tag claims local capture. The package-created
capture transport remains admitted and network-free.

The maintained factory is explicitly registered through
`admitPolicyEnforcedEmailTransport` because its existing client already enforces
egress. That trusted host bridge must only register policy-enforcing senders;
it adds no routing or credential change. Auth keeps that admission through
`createAuthEmailTransport`, preserving the original envelope mapping. See the
[package contract](../../../packages/platform/README.md#communications-import)
for decision fields and the M04 changed-expectation ledger.

## Current source wiring

The three reference transactional, dunning and marketing factories accept an
optional transport and retain their existing maintained default selection.
Invoice delivery requires an injected transport. Each of these four effect
sites calls the neutral guard. The neutral admin-role and public-intake ports
also require injection and call the same guard. The Auth hook checks its own
transport admission and the API preserves maintained admission through the
package envelope bridge. Runtime composition passes the explicitly admitted
maintained factory where it already did; routes and schedules remain unchanged.

This inventory describes source composition, not a selected or deployed provider.
The concrete client remains the owner of the maintained policy and wire mapping.

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
