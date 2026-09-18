# communications domain

Email templates, sends, event history, notification recipients, consent
permissions, send-policy decisions, and newsletter provider sync semantics. The
single boundary for transactional/marketing email side effects.

## Owns / does not own
- **Owns:** email templates, email sends, event history, notification
  recipients, consent/permission audit, provider-neutral newsletter sync ports,
  customer self-service marketing newsletter preference contracts, Resend send
  semantics, and the PII-safe customer delivery timeline projection
  (`communication_email_deliveries`).
- **Does not own:** tester status ownership (`tester-program`), client identity
  or lifecycle facts (`clients`), DHL state (`fulfillment`), feedback content
  (`feedback`), or legal copy approval.

## Public surface (import cross-domain ONLY these)
- Admin clients: `admin*Client.ts` files for templates, active/content edits,
  email sends/events, notification recipients, permission reads/overrides and
  manual send-email. Packaging-digest testing is not a public capability: its
  legacy BFF alias remains mounted only as a terminal empty-`404` compatibility
  tombstone, with no client, runner or sender. The tester detail email send
  client is likewise absent: that programme ended and its private historical
  residue is not part of the published tree.
- Newsletter sync ports in `ports.ts`; execution adapters live under
  `server/adapters/<provider_kind>/`, while provider HTTP/signature/env glue lives
  under `server/infra/<provider_kind>/`. Provider-neutral contracts, canonical
  webhook event shapes, and capability declarations live in
  `newsletterIntegrationContracts.ts`.
- Shipment notification planning: `shipmentNotifications.ts` maps
  fulfillment/customer-safe shipment states to existing email template slugs and
  idempotency keys. It does not send mail by itself.
- Shared contracts/ports/types: `contracts.ts`, `ports.ts`, `types.ts`,
  `status.ts`.
- Customer preferences: `customerPreferencesContracts.ts` and
  `customerPreferencesClient.ts` expose the authenticated customer-account
  `marketing_newsletter` BFF surface. The route lives under
  `api/bff/customers/communication-preferences` because customer auth and
  ownership are a `customers` boundary; the permission write remains a
  communications RPC/audit event.
- Branded email renderer: `email/*` — `render.ts` (canonical chrome: logo,
  card, accent boxes, CTA, footer), `blocks.ts` (block contract + builders that
  business domains compose), `theme.ts` (`EmailTheme` value tokens, injected so
  forks can re-skin), `strings.ts` (PL/EN chrome copy), `links.ts` (absolute CTA
  URL builder; localized paths mirror `src/lib/i18nRoutes.ts`). Pure TS, so
  every Node sender renders through the same code; that portability was
  originally for the Deno edge senders, retired 2026-09-05. `EmailRenderPort` in
  `ports.ts` lets a fork swap the renderer.
- Email canon registry: `emailCanon.ts` exports `EMAIL_CANON_REGISTRY`,
  `EMAIL_CANON_DYNAMIC_PATTERNS`, `EMAIL_CANON_LIFECYCLE_DECISIONS`, and
  `findEmailCanonEntry()`. Every runtime sender slug or dynamic slug family must
  be represented there with owner, trigger, recipient kind, renderer, origin
  policy, timing, idempotency, ledger, locale policy, and test coverage. Keep
  docs as explanation; keep this file as the executable catalog. The registry
  also carries `inventoryStatus` and `deliveryStatus`, so runtime, legacy
  inline, admin-only, planned/contract-only, no-send, fixture-only, and external
  provider entries cannot collapse into a vague "known slug" bucket.
  `policyFailureMode` is also explicit: customer-facing and marketing/link
  sensitive mail fails closed when the app/customer origin policy is invalid;
  admin/internal notifications may fail open only with audit metadata.
- Email registry projection: the public domain imports exactly one neutral
  `#email-registry-projection` seam. Its default implementation,
  `exampleEmailRegistryProjection.ts`, is empty, so the published platform
  materializes only its portable registry, verification, edit-guide, routing,
  and DB-template policy. A deployment overlay may replace that one alias with
  its own projection and anchored insertions without adding private slug,
  recipient, route-kind, locale, or DB-template unions to public source. The
  managed overlay retains its terminal no-send history, dynamic entries, and
  deployment-specific DB policy/vocabulary. `packaging-digest-daily` is absent
  from both public and managed DB/editor policy and remains only as a private
  route-free `no_send` envelope. Projection insertion is fail-closed on missing
  anchors and duplicate keys, and registry array order is part of its
  characterized contract.
- Email origin policy: `email/originPolicy.ts` is the Node source of truth for
  customer CTA origins. It normalizes `openlup_BASE_URL`,
  `CUSTOMER_AUTH_REDIRECT_ORIGIN`, and `SITE_URL`, rejects invalid URL values,
  and fails closed for hidden-preview/preview/staging when the resolved origin is
  missing or points at `openlup.com`. This is the only implementation; the Deno
  mirror it was paired with went with the Edge tree on 2026-09-05.
- Delivery timeline: `communication_email_deliveries` answers "was this
  customer-facing email expected, queued, sent, delivered, blocked, failed, or
  missed?" by linking existing source ledgers (`outbox_events`, `email_sends`,
  `email_events`, `communication_send_decisions`, `platform_job_runs`). It must
  not become a second send ledger and must never store tokens, magic links,
  email bodies, or raw provider payloads with PII. Its `id` is the
  `sendAttemptId`: customer-facing Node Resend adapters must create/read a
  `processing` row before the provider POST, include that id in sanitized
  provider metadata, and then update the same row with the final provider
  outcome. One `processing -> sent|failed|delivery_delayed` transition is one
  provider attempt, not two.
- Provider lifecycle convergence: the signed Resend webhook and the existing
  delivery reconciler call one service-role RPC that atomically owns
  `email_events`, `email_sends`, and timeline transitions. Callers must pass a
  stable provider occurrence id and provider event time; they must not add
  separate projection writes or a parallel status mapper. Provider complaints
  and suppressions use the existing permission/provider-event ledgers inside
  the same transaction; the poller uses `poll_last_attempt_at` only to rotate
  bounded reconciliation batches fairly.

## Email content rules (apply to every domain that composes blocks)

These are brand + deliverability rules for the *content* domains build, not the
chrome. They hold across `src/domains/*/emails/*` and every Node sender.

### Education, not promotion, in transactional mail
A **transactional** email (order draft/paid/canceled/refunded, payment-failed,
shipment dispatched/delivered, subscription lifecycle) may carry only
**education or relationship** content: how to feed, what to expect, the
gut-health story behind the food. It MUST NOT carry promotional content — no
discount codes, no "use code X", no cross-sell or upsell, no campaign offers.

Why: a discount/offer flips the message's CAN-SPAM *primary purpose* to
commercial, which (a) changes the legal/consent footing of a mail the customer
gets without marketing opt-in, and (b) hurts deliverability of the
transactional stream. Showing the order's OWN totals — including its discount
line — is fine; that's the receipt, not a new offer.

Offers, codes, and upsells live ONLY in the **consent-gated marketing** stream
(abandoned-cart, reorder reminder, review, waitlist, back-in-stock) — those carry
the `marketing_newsletter` consent gate + the unsubscribe footer. A soft, honest
subscription nudge ("want it to arrive on its own? pause anytime") is allowed
there because it is consent-gated and makes no false-urgency/price promise.

### Emoji policy
- **Transactional + "science"/education emails:** zero emoji.
- **Purely relational emails** (welcome, thank-you): at most ONE on-brand 🐾.
- Never stack emoji (no `🎉📦😄`); never use emoji as urgency/hype.
- Internal/operational notifications (admin digests, B2B/feedback alerts) are out
  of scope — this policy is about customer-facing mail.

## Where the code lives
- Shared/frontend: `src/domains/communications/`
- Server: `server/domains/communications/` (admin template/send/recipient/email
  history handlers, consent sync workers, webhook handlers, service-role ports);
  provider execution adapters such as admin send-email and packaging digest dry
  runs live under `server/adapters/resend/`.
- BFF routes: `api/bff/admin/communications/` for admin surfaces,
  `api/bff/communications/` for public preferences and provider webhooks, plus
  a deployment-owned handler for authenticated customer
  self-service newsletter preference updates.
- Cron routes: `api/cron/communication-sync-*` disabled by default through env
  flags and `platform_job_controls`.
- Edge senders: retired. `send-email` is removed from source, after the ended
  tester/waitlist queue and digest roots were removed before it; the Node BFF
  route `server/bff/admin/communications/send-email.ts` and the outbox handlers
  own every remaining transactional send. `on-status-change` remains as hosted
  legacy database-webhook compatibility code.

## Newsletter provider adapter checklist

- Add provider HTTP/env/signature code under `server/infra/<provider_kind>/`.
- Add the execution adapter under `server/adapters/<provider_kind>/` implementing
  `NewsletterSyncProviderPort` with explicit capabilities.
- Register the adapter in `server/domains/communications/newsletterProviderRegistry.ts`;
  `COMMUNICATION_NEWSLETTER_PROVIDER_KINDS` controls enabled providers.
- Map provider webhook payloads to `NewsletterWebhookEvent` or post the canonical
  signed event to `/api/bff/communications/integrations/events`.
- Keep provider unsubscribe/complaint/suppression as local `suppressed` events.
  Provider subscribe may grant only with explicit opt-in evidence or confirmed
  double opt-in.
- Do not store provider secrets in DB. Store remote ids and sanitized event or
  delivery evidence only.

Domain-boundary rules live in the maintainer canon `DOMAIN_ARCHITECTURE.md`,
which belongs to the private overlay and is not part of the published tree.
