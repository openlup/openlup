# Inert newsletter provider infra

Status: source-of-truth
Verified against `0dc20d72` (2026-09-04) - scope: the single runtime file in
this directory and its one BFF caller, found by grep across the source tree.

`server/infra/noop_newsletter` is the provider-infra half of the deliberately
inert newsletter provider. It exists so the newsletter integration has a real,
signature-verified webhook path that reaches no external vendor.

## Owns

`webhookVerifier.ts`, and nothing else. It exports one function,
`verifyNoopNewsletterWebhookSignature({ req, rawBody, secret })`. The function
returns `false` when no secret is configured, reads the signature header (taking
the first value when the header repeats), and delegates the comparison to the
shared `verifyHmacSignature` helper in `server/_lib/payment/webhookSignature.ts`.

Its only caller is `server/bff/communications/webhooks/noop-newsletter.ts`,
which returns an unauthorized response when verification fails.

## Does not own

- Payload shaping, response synthesis, or any simulated provider behaviour. This
  directory contains no payload builder and no fixture; earlier versions of this
  file claimed otherwise.
- Consent policy: `server/domains/communications`.
- Newsletter execution adapter contracts: `server/adapters/noop_newsletter`.
- Public or admin BFF route composition: `server/bff/communications`.

## Sharp edges

- Inert behaviour must never imply a real provider send. Nothing here produces a
  send receipt.
- The verifier fails closed on a missing secret; keep it that way, or an
  unauthenticated caller can post newsletter events.

## For an adopter

This is the reference shape for a newsletter provider: verify the signature at
the infra boundary, and keep every consent and eligibility decision in
`server/domains/communications`. Replacing it means writing a verifier for your
provider's scheme and pointing the BFF webhook route at it.
