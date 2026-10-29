# Communications integration signature adapter

Status: development-preview guidance. The package owns the signature algorithm;
this directory provides the server-facing compatibility import and its focused
refusal witness.

## Owns

`integrationEventSignature.ts` re-exports the public package implementation. It exports:

- `signCommunicationIntegrationEvent(...)` - HMAC-SHA256 over
  `` `${timestamp}.${rawBody}` `` with the shared secret, hex-encoded.
- `verifyCommunicationIntegrationEventSignature(...)` - the verifier. It fails
  closed when the secret, the signature header or the timestamp header is
  missing, rejects a non-numeric timestamp, rejects a timestamp more than
  `COMMUNICATION_INTEGRATION_SIGNATURE_TOLERANCE_SECONDS` (300) away in either
  direction, strips an optional `sha256=` prefix, and compares in constant time
  through `timingSafeEqual` after a length check.
- The two header-name constants the callers read.

Callers: `server/bff/communications/integrations/events.ts` and
`server/bff/marketing/research/newsletter-consent.ts`.

## Does not own

- Consent and recipient eligibility: `server/domains/communications`.
- Provider API calls or email rendering: `server/infra/resend`.
- The neutral send seam: `server/infra/email`.
- Newsletter execution adapter behavior: `server/adapters/noop_newsletter`.
- Any error type. There is no sanitized-error helper here; provider error
  sanitization lives with each provider client.

## Sharp edges

- The comparison must stay timing-safe. Do not replace `timingSafeEqual` with
  `===`.
- The timestamp window is symmetric on purpose: a far-future timestamp is as
  invalid as a stale one.
- Callers must pass the raw request body, not a re-serialized object, or every
  signature will mismatch.

## Protocol compatibility

The exported header constants use the public OpenLup protocol names. Callers
using this package contract must send those headers; this documentation does not
recommend editing platform source to rename them for a particular deployment.
An application with a different inbound protocol owns its own adapter and
compatibility decision.
