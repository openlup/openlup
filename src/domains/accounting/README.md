# Accounting domain

Status: development-preview source guidance.

Accounting owns document history and the contracts and ports surrounding fiscal
document issue, correction, provider synchronization, settlement evidence and
document delivery. This page links the shared contracts to their meaningful
server units; source existence does not establish a configured provider or an
active installation.

## Owns / does not own

- **Owns:** accounting document states and read history, invoice/control DTOs,
  issue/correction claims, payment preflight evidence, canonical document-line
  checks, synchronization and delivery ports, and accounting job orchestration.
- **Does not own:** checkout totals or completed-order money allocation
  ([commerce](../commerce/README.md)), payment execution
  ([payment](../payment/README.md)), shipment execution
  ([fulfillment](../fulfillment/README.md)), email transport
  ([communications](../communications/README.md)), or an adopter's seller
  identity, jurisdiction policy and provider selection.

## Shared contracts

| Surface | Responsibility |
| --- | --- |
| [contracts.ts](contracts.ts), [accountingDocumentHistory.ts](accountingDocumentHistory.ts) | Cross-domain document history and its visible artifact, role and email states. |
| [invoiceContracts.ts](invoiceContracts.ts), [accountingControlContracts.ts](accountingControlContracts.ts), [accountingConstants.ts](accountingConstants.ts) | Invoice snapshots, validated issue/sync/settlement/control requests and status vocabulary. |
| [ports.ts](ports.ts) | Accounting read/control/runtime ports and claimed-work contracts. |
| [providerPorts.ts](providerPorts.ts) | Neutral document-provider snapshot, issue/correction and download capabilities. |
| [invoiceDeliveryPorts.ts](invoiceDeliveryPorts.ts) | Delivery of an already-created document, with separate `sent` and `uncertain` outcomes. |
| [outboxReversalContracts.ts](outboxReversalContracts.ts) | Accounting outbox reversal contracts. |
| [accountingClient.ts](accountingClient.ts) | Typed client for the accounting BFF interfaces. |

The neutral tax-ID routing default in [invoiceContracts.ts](invoiceContracts.ts)
refuses a supplied identifier when no jurisdiction routing is configured.
Current lookup/control schemas also expose Polish NIP and KSeF vocabulary.
Inspect the selected composition and policy before treating those fields as
jurisdiction-neutral behavior; supplying a seller snapshot is not tax-policy
approval.

## Issue and amount preflight

Start with
[accountingJobService.ts](../../../server/domains/accounting/accountingJobService.ts).
An issue job refuses disabled configuration or a missing provider before
claiming work. For each claim it performs local canonical-payment preflight,
maps the claimed snapshot, obtains provider payment evidence, and performs the
final preflight before document creation.

The important internal boundaries are:

- [accountingCanonicalProviderLines.ts](../../../server/domains/accounting/accountingCanonicalProviderLines.ts)
  independently checks persisted item/delivery amounts, discount allocation,
  VAT and header sums. It must not invent document amounts from presentation
  copy or a current quote.
- [accountingProviderSnapshot.ts](../../../server/domains/accounting/accountingProviderSnapshot.ts)
  builds the provider snapshot and applies tax-ID safety checks. Named canonical
  mapper failures block the issue rather than schedule a misleading retry.
- [accountingPaymentReadback.ts](../../../server/domains/accounting/accountingPaymentReadback.ts)
  preserves missing, incomplete or failed provider evidence as explicit
  unavailability; it does not invent amount/currency agreement.

A final preflight block must stop the document-provider call. Reclaimed invoice
work requests provider recovery lookup before creation. Claim-attempt fencing
prevents a stale success handler from failing a newer claim. Inspect the
[job tests](../../../server/domains/accounting/accountingJobService.test.ts),
[line tests](../../../server/domains/accounting/accountingCanonicalProviderLines.test.ts)
and [payment-readback tests](../../../server/domains/accounting/accountingPaymentReadback.test.ts)
for those falsifiers.

## Delivery and uncertainty

[accountingInvoiceDeliveryJob.ts](../../../server/domains/accounting/accountingInvoiceDeliveryJob.ts)
delivers an existing document; it never creates or alters the fiscal document.
The job verifies provider identity, recipient, delivery idempotency key and PDF
content before calling the email delivery port.

The [delivery port](invoiceDeliveryPorts.ts) requires `uncertain`, rather than a
throw, after entering transport. Provider acceptance followed by missing local
acknowledgement also takes the uncertain transition. It must not become a
retryable failure that could send a second document email. Pre-transport failures
and confirmed success have separate fenced transitions.

Inspect
[delivery tests](../../../server/domains/accounting/accountingInvoiceDeliveryJob.test.ts)
for invalid document/provider/key inputs, uncertain transport and uncertain
local finalization. A unit result does not prove actual mailbox delivery.

## Other internal entrypoints

- [accountingHandlers.ts](../../../server/domains/accounting/accountingHandlers.ts)
  contains HTTP handler factories for authenticated control and read operations;
  it retains transport types. Routes and adapter construction belong to BFF
  composition.
- [fulfillmentHandoffInvoiceHandler.ts](../../../server/domains/accounting/fulfillmentHandoffInvoiceHandler.ts)
  and [fulfillmentInvoiceTrigger.ts](../../../server/domains/accounting/fulfillmentInvoiceTrigger.ts)
  connect fulfillment evidence to invoice eligibility.
- [accountingDocumentSync.ts](../../../server/domains/accounting/accountingDocumentSync.ts)
  handles provider document synchronization;
  [stripePayoutSettlementSync.ts](../../../server/domains/accounting/stripePayoutSettlementSync.ts)
  maps the named provider's payout evidence into settlement work.
- Provider execution lives behind [adapter contracts](../../../server/adapters/README.md),
  outside browser-shareable accounting contracts.

## Verification and next links

The [root public test command](../../../package.json) collects both the shared
contracts under `src/domains/accounting` and the jobs and handlers under
`server/domains/accounting`. Run that command for the full root suite, or name
the affected test files while iterating. These links identify tests, not current
passing results:

- [invoiceContracts.test.ts](invoiceContracts.test.ts)
- [ports.test.ts](ports.test.ts)
- [accountingDocumentHistory.test.ts](accountingDocumentHistory.test.ts)
- [accountingHandlers.test.ts](../../../server/domains/accounting/accountingHandlers.test.ts)

Read [contribution checks](../../../CONTRIBUTING.md#development-preview-checks)
for execution scope, [canonical contracts](../../../docs/platform/CANONICAL_CONTRACTS.md)
for money/status/idempotency boundaries, and
[Data and migrations](../../../docs/platform/DATA_AND_MIGRATIONS.md) for durable
schema authority. Record the actual command and result at the revision tested;
mocked jobs do not prove live provider, database or installation behavior.
