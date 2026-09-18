# Customers server domain

Status: source-of-truth

Server-side handlers and ports for the authenticated customer account BFF
surface.

## Owns

- Customer-authenticated account aggregate handlers.
- Customer-safe profile, pet, address, billing/orderer, order history/detail,
  subscription-action, invoice correction intent, payment recovery, and invoice
  PDF download handler boundaries.
- Ownership checks that map the logged-in Supabase auth user to local client,
  order, invoice, and subscription facts.

## Structural Slices

The next physical split follows the boundary in
[Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md); deployment-only registry and
architecture checks verify the following current customer account aggregate
slice targets:

- `profile`: customer-safe profile, pets, addresses, preferences, and billing
  profile surfaces.
- `subscription-summary`: subscription preview, action, and facade read paths.
- `order-summary`: order history, tracking, invoice summary, correction intent,
  fiscal document lineage, and ownership-scoped invoice/correction PDF download
  surfaces. The singular invoice is the current issued/accepted document;
  corrected originals remain history-only.
- `action-required`: aggregate diagnostics and action-required read model
  composition.

## Does not own

- Physical client/pet/address persistence ownership (`clients`).
- Order/payment/subscription/accounting ledger mutation (`commerce`, `payment`,
  `subscription`, `accounting`).
- Fakturownia PDF HTTP details (`server/infra/fakturownia`).

## Safety

Most customer routes use the caller's bearer token and must not expose
service-role details, PSP provider ids, raw accounting snapshots, shipment
provider payloads, or Fakturownia tokens. Session bootstrap and recovery routes
are explicit exceptions: `magic-link` is sessionless with anti-enumeration
behavior, and abandoned-checkout recovery uses opaque recovery tokens rather
than an existing login session. Invoice PDF download is read-only: it verifies
invoice -> order -> client ownership on every request, streams the PDF with
`no-store`, and does not create, resend, correct, or submit invoices.

Customer handlers own authenticated facade and ownership checks; subscription
lifecycle, payment truth, order facts, and email delivery stay in their owning
domains. `SUBSCRIPTION_ORIENTATION.md` remains a private maintainer canon, not
a public contributor prerequisite or public boundary owner.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
