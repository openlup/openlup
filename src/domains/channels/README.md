# channels domain

Category-neutral sales-channel abstraction: external marketplaces (direct or
via an aggregator), and any future sales source (storefront, mobile app, POS)
treated as an order origin. The domain defines the normalized external-order
contract, the connector port both connector shapes implement, buyer-comms and
sales-document policy, and the outbox event vocabulary.

The domain is past contracts-only: the ingest saga, its store seam and two
default-off physical entrypoints exist and are described below. What is still
absent is a real connector — the only one in the tree is a file-fixture
simulator — and the three rails the saga borrows are an unbound slot until a
composition binds them.

## Owns / does not own

- **Owns:** the `channel.order.v1` normalized order contract, the
  `ChannelConnectorPort` seam (capabilities descriptor + order source /
  listing sync / stock-price push / shipment sync sub-ports), the
  channel-vs-platform buyer-comms policy, sales-channel lifecycle and policy
  vocabularies, and the `channel.*` outbox event contracts.
- **Does not own:** order persistence or order state (commerce), payment
  truth (payment control plane), fulfillment execution or status canon
  (fulfillment), invoicing (accounting), catalog/bundle data (catalog,
  bundle), inventory reservations (inventory), or any concrete marketplace /
  aggregator adapter (those live under `server/adapters/<connector>/` behind
  this domain's port).

## Public surface (import cross-domain ONLY these)

- `contracts.ts` — shared vocabulary: slugs, connector/channel kinds,
  statuses, comms/invoice policy, currency/country/external-ref schemas.
- `orderContracts.ts` — `channel.order.v1` normalized order + unmapped-signal
  schema.
- `ports.ts` — connector port types.
- `orderCommsPolicy.ts` — pure buyer-comms policy helper.
- `orderInvoicePolicy.ts` — its sibling for sales documents: a channel that
  issues its own must not also receive one from here, and a channel that
  suppresses it must not have one minted.
- `bundleLineExpansion.ts` — expands a marketplace bundle line into the
  component lines this shop can reserve and ship, splitting the
  channel-final money rather than re-pricing it.
- `channelOpsClient.ts` — the operator client for an ingested order's ledger row
  and its channel's open-quarantine count.
- `outboxEventContracts.ts` — `channel.*` outbox event constants + payloads.
- `channelIngestStorePort.ts` — the ingest saga's persistence seam (B4), the
  saga's status/quarantine vocabularies, and the four NARROW interfaces for the
  rails the saga borrows rather than owns (payment control, inventory
  reservations, order-item reads, channel reads). Those four live here rather
  than being imported from `commerce` because `runtimePorts.ts` is not a public
  cross-domain segment; the existing commerce adapters satisfy them structurally
  and composition passes them in.

## Design rules (binding for later waves)

- Identity spaces (channel slugs, connector kinds, sellable kinds) are open
  validated strings — never `z.enum`; a closed union of connector brands in a
  wire contract is forbidden.
- Buyer email is NEVER an identity key (marketplace relay/alias addresses);
  buyer dedupe runs on `customer_external_refs` only.
- Unknown wire vocabulary is quarantined loudly and durably, never dropped
  (B3); mapping is keyed on wire enums, never panel labels (B1); business
  effects fire from partner-confirmed signals only (B5).

## Where the code lives

- Shared/frontend: `src/domains/channels/` — contracts, ports, the pure comms /
  invoice / bundle-expansion policy, the store seam, and the operator client.
  No persistence and no provider code.
- Server: `server/domains/channels/` holds the ingest saga and its policy
  (`channelOrderIngestSaga.ts`, `channelIngestAdmission.ts`,
  `channelConnectorRegistry.ts`, `quarantineClassifier.ts`) and contains zero
  `.from`/`.rpc`. Connector adapters live under `server/adapters/<connector>/`,
  starting with the `noop_channel` simulator whose fixtures are loaded from
  files. Persistence adapters live under `server/adapters/<store>/` behind the
  semantic store port — one per supported platform bundle — and are selected by
  `server/runtime/channelIngest/channelIngestStoreBinding.ts`.

## Ingest saga shape (B4)

The step order is the checkout order, and that is the point: reserve → create
intent → record attempt → ingest settlement event → apply result. Stock is taken
before the payment rail is touched, so an order that cannot be stocked never
acquires a payment intent and can never be settled. A stock refusal leaves the
order `draft` and the ledger `blocked_stock`; the resume re-enters at
reservations under the same key. Every idempotency key is
`ch:{channelId}:ord:{externalOrderRef}:{step}`, so a run that dies anywhere and
restarts from the top re-derives the same rows.

The direct-Postgres store is real for the three boundaries the public platform
catalogue authors and refuses the other two BY NAME: that catalogue has no
identity, address or payment-control rail, so an order writer there would be a
fabrication.

## How a channel parcel ships

A marketplace is a sales channel, not a form of distribution. Its orders leave by
the same fulfilment rail and the same provider as an order placed on the
storefront, and nothing downstream of `paid` has a channel branch in it.

The one thing a marketplace cannot supply is the delivery selection a storefront
buyer makes at checkout, which is what the dispatch candidate gate resolves the
shipping provider through. So the surface declares it instead:
`sales_channels.delivery_selection` holds the same object an order carries as
`metadata.selectedDelivery`, the ingest copies it verbatim onto every order it
writes, and everything after that behaves identically — provider routing, stock
authority on the reservation, dispatch eligibility, replacements.

Three properties make that a declaration rather than a guess:

- **It is refused when absent**, at admission and again at the SQL boundary, so
  no order exists for a surface that has not said how it ships. Before this, such
  an order reached `paid`, acquired a fulfilment row, and then silently never
  became a dispatch candidate.
- **What the far side asked for is kept next to it.** The marketplace's own
  `shipping.methodLabel` and `carrierHint` land on the order as
  `metadata.channelShippingRequest`. They are never translated into this shop's
  options — the vocabularies do not correspond — but they are never discarded
  either, so an operator can always compare what shipped against what was bought.
- **It is overridden the way any order's selection is overridden.** The resolver
  reads the fulfilment row's own copy first, then the order's, then the address;
  the surface declaration is simply what the order was born with.

## Physical entrypoints (B5)

Two, and both default-off.

- **Webhook** — `POST /api/bff/channels/webhooks/simulator`, one route per
  connector kind built by `server/bff/channels/webhooks/_handler.ts`. Guard order
  is method → `CHANNEL_INGEST_WEBHOOK_ENABLED` → `CHANNEL_WEBHOOK_TOKEN`, and
  every failure path is answered by a port that cannot write. The four connector
  results map to four answers: rejected → `403`/`400`, ignored → `200`, unmapped
  → quarantined then `200`, order → the saga. An admission refusal answers `409`;
  acknowledging it would make a misconfigured channel look like a working one.
- **Poll** — `/api/cron/channel-order-pull`, gated by
  `CHANNEL_ORDER_PULL_ENABLED` *and* a `platform_job_controls` row seeded
  disabled in both migration chains. It advances a connection's `pull_cursor`
  only over a page whose every order reached a terminal answer.

The saga's three borrowed rails — reservations, order items and payment control —
are an explicit unbound slot on
`server/runtime/channelIngest/channelIngestComposition.ts`. Until they are bound,
an ORDER answers `channel_ingest_rails_unbound` and writes nothing, while the
quarantine path works end to end.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
