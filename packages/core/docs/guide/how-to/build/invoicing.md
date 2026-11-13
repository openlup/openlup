# Compose invoicing

Compose invoice duties, issue jobs, document reads and delivery around explicit
host facts and provider ports. Your application supplies fiscal policy,
authorization and scheduling; invoice availability must not gate physical
delivery or renewal payments.

## Select the ports

Import runtime helpers from `@openlup/platform/invoicing` and types from
`@openlup/platform/invoicing/contracts`. The contracts entry exports declarations
only. Import captured sandbox storage and account history from
`@openlup/platform/invoicing/postgres`.

Call `readInvoiceCapabilities` with explicit activation, provider selection and
the matching capability descriptor. It returns `disabled` unless enabled is
exactly true, and `selection_required` for missing or mismatched selection.
These refusals precede host calls. A ready result describes declared operations;
your host still owns fiscal validation. Consult the
[package maturity table](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/AGENTS.md#subpath-maturity)
for the capability boundary.

Bind an `InvoiceProviderPort`, an `InvoiceStorePort` and `InvoiceHostPorts`.
The host ports cover:

| Port | What your application provides |
| --- | --- |
| `facts` | Frozen order, buyer, ordered lines, tax, dates, references and money |
| `seller` | Current seller configuration and immutable `revisionRef` for the next claim |
| `money` | Read-only evidence for the claimed payment identity and expected money |
| `fiscal` | Identifier, tax, rounding and jurisdiction policy verification |
| `registry` | Company evidence lookup |
| `artifacts` | Durable artifact references, authorized downloads and persistence |
| `clearance` | Observations of submission state |
| `delivery` | Document transport with explicit accepted, uncertain and pre-send outcomes |
| `settlement` | Recording and resolving distinct payout items |
| `policy` | Issue/suppress/skip decisions and recorded receipts |
| `accountHistory` | Owned document history and download authorization |

Keep original request-key bytes, fact revision and provider create identity.
Money uses safe integer currency minor units. Preserve nullable legacy facts; do
not fill missing tax or money with invented values. The provider owns fiscal
numbering; local invoice references and nullable external document numbers are
distinct. Keep ordered canonical line amounts, explicit delivery and discount
components, dates and references. These contracts supply no currency conversion,
catalogue reread or assumed tax substitute. Identifier, tax and rounding policy
references select your fiscal policy; there is no built-in country rule.

Registry evidence carries the identifier scheme, legal name, optional
registration/address/tax facts, source, fingerprint and observation time. Your
host validates identifiers, freshness and fallback. Registry evidence does not
replace checkout facts or become a renewal prerequisite.

## Run duties and issue jobs

Construct `createPostgresInvoiceStore(executor, { seller })` with a host-owned
autocommit executor over the installed invoice schema. It reads the seller
before claiming work and freezes the first-claim seller revision. Missing
seller binding or invalid installed facts returns `unsupported` with
`host_binding_required` before leasing. Keep database transactions committed
before provider or other host I/O; a complete store method can span several
transactions and host callbacks.
The structural native store accepts provider selection per claim and persists
the first provider on the duty; compatibility stores bind it at construction.

Use `captureDuty` for retained paid or handoff evidence and `installFacts` for
the duty's frozen `InvoiceFacts`. The collector can recover retained sources,
but missing facts remain owed until your application installs their revision.

Install the [complete selected catalogue](../../upgrade/database-migrations.md),
not the module's sparse `INVOICING_MIGRATIONS` assets. Native child-document and
managed base-row correction storage are distinct. Collection uses separately
committed store phases, outside payment and fulfillment execution. A collection
failure must leave the original service outcome intact and the document duty
observable for retry.

Use `runNativeInvoiceIssueJob` with the store, provider, selected `providerRef`,
host `money` port and `readLocalPayment`. Supply claim scope through `orderId`,
`limit` and `visibilitySeconds` as needed. For an existing callback-based host,
`runInvoiceIssueJob` accepts claim, preflight, projection, payment read,
provider create and fenced finish/fail callbacks; `runInvoiceCorrectionJob`
provides the correction counterpart.

Alternatively, `createInvoiceServices` binds selected ports, readiness and
explicit jobs or factories. It checks activation, provider selection and
readiness before invoking them. It creates no scheduler or invocation lease.
Invoke `createIndependentInvoiceDutyBinding` separately from payment and
fulfillment execution so a collection failure remains retryable independently.

`createInvoiceContribution`, exported from the same invoicing entry, describes
your selected operations and registrations without mounting them.
`claimInvoiceSellerRevision` reads an injected seller selection before leasing;
unknown or unsupported selection consumes no claim. Persistence of that first
revision belongs to the selected store, not an in-memory cache.

Issue and full-reversal recovery must use the full immutable identity, including
revision, operation and parent document. Preserve unknown remote outcomes.
Only exact, complete absence for that scope can authorize another create;
failed, ambiguous or unsupported lookup cannot. A full reversal carries
immutable before facts and explicitly cleared after totals. Remote void is unsupported
and must not be substituted with local pre-issue void.

Keep unsupported duties visible. `unsupported_recorded` means reversal intent
was recorded but cannot be fulfilled by that native path. A reversal result of
`missing` does not prove invoice absence. Retain the intent and route existing
documents to their owning adapter. Policy suppression (`channel_issues` or
`no_document`) and operator skips retain receipts without fabricating document IDs.

For deliberately unbound composition, `createNativeUnsupportedInvoicePorts()`
returns host, store and provider ports that return `host_binding_required`,
`retryable: false` and `effectMayHaveSucceeded: false`. This refusal describes
only the current call; it cannot settle an earlier unknown outcome or prove
absence. The factory takes no executor or configuration and inspects no input.
Keep earlier unknown duties visible for an admitted adapter or operator.

## Adapt existing invoice callbacks

For a callback-based invoice host, select the mapping, allocation, payment-read
and handler helpers from the [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/invoicing.api.md).
Supply saved facts, fiscal presentation policy, selected provider readers and
fenced host callbacks as required by the chosen helper. Reversal handlers use
a bounded timeout; account for that deadline in your host callbacks.

A correction recovery bridge must prove both the parent document and correction
reference. Local-only requests preserve provider selection, document ID, invoice
reference, status and replay. If a reversal was requested while the remote issue
outcome was unknown, late acceptance retains its external identity and
atomically creates its deduplicated compensation duty at finalization.

## Deliver documents

Use `runInvoiceDeliveryJob` in store mode with `store`, `claimOptions`,
`download`, `filename`, `send` and the enable flags. Construct the PostgreSQL
store with `projectDelivery` as well as `seller` if it serves both jobs. The
projector resolves recipient, presentation and original delivery keys after
lease. Without it the store refuses before leasing. A projection exception
settles that row as retryable `failed_before_send`; an envelope identity or
attempt mismatch settles it as non-retryable. The checks include document,
order, provider and projected attempt identity. Document-read exceptions use the
retryable branch too. Neither branch sends or creates an uncertain receipt.
Other valid rows can continue; job counters include only returned valid claims.

Callback mode requires claim, validation, download, filename, send and fenced
finalizers. Bind `terminalFailure` before claiming; its absence skips with
`host_binding_required`. Retryable pre-send failures use backoff; terminal
pre-send failures stop reclaiming. Native retryable settlement carries `{ phase:
"before_send", retrySeconds }`, with bounded whole-second delays and a fallback
for absent or invalid values. Terminal settlement carries `{ phase: "before_send",
retryable: false }`, parks availability at infinity and leaves failed status and
the diagnostic visible. Projection failures and job retries use bounded
attempt-based backoff; consult the
[maintainer delivery limits](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#invoicing-read-helpers)
for exact delays and fallback values. Store mode supplies these finalizers. Once transport
has been entered, `send` must return `uncertain` for a timeout or lost
acknowledgement. Throwing is permitted only before transport entry. An uncertain
send never authorizes a blind repeat send, and provider acceptance does not
prove inbox delivery.

`assertInvoicePdf` validates MIME type, nonempty content, size and PDF signature
before sending or returning bytes. Its errors are
`invoice_pdf_content_type_invalid`, `invoice_pdf_empty`, `invoice_pdf_too_large`
and `invoice_pdf_signature_invalid`. `invoicePdfFilename` sanitizes a reference
and accepts your fallback caption.

## Read and synchronize evidence

`createInvoiceReadModel` takes optional account-history, artifact-download,
provider-read and duty-read ports. Missing bindings return `unsupported` with
`host_binding_required`. Account history checks account/order identity and
whitelists fields; download resolves authorization before fetching and
validating PDF bytes. Authorize operator duty reads in your application.
`resolveInvoiceDocumentHistory` builds chronological original, correction and
replacement history from projected columns. Provider readback preserves `found`,
exact `absent`, `unknown` and `unsupported` as separate outcomes; it supplies no
default query or storage. Keep HTTP, authentication and service SDKs inside your
host callbacks.

Account history is a complete owned projection, with order/parent lineage,
signed correction totals and currency. Incomplete history is `unknown`. Omit
buyer payloads, raw diagnostics and signed URLs; your application owns customer
authentication, operator authorization and retention.

Merge policy receipts, including `recordedAt`, with owed duties. Decide
suppression before installing facts: a suppressed order gets no local document.
Operator skips retain actor, reason and original key. Duty readback includes
capture faults, duty/parent/document identity, state, attempts, closed
diagnostic code and lease chronology; ready work is owed and processing work is
claimed. Unsupported duties stay visible. Empty duties or `accountingRequested:
false` do not prove invoice absence; capture faults remain separately
observable.

`syncAcceptedInvoiceDocuments` takes attachment download and recording
callbacks. In observation mode, also supply targets, observation, status
recording and an accepted-status predicate. It records status before syncing
accepted documents; it downloads attachments concurrently, records their
metadata and provider references, and counts per-target failures. It neither
stores blobs nor submits clearance itself.

`syncInvoicePayoutSettlements` takes `list`, `project` and `settlement.record`.
The projection may resolve links through your host. Preserve nullable links; a
host recorder/resolver must not silently merge item identities. Each projected
payout item needs a distinct item receipt even when batch and payment match.
Recorder results of unknown, conflict or unsupported throw; they do not count as
success. If a recorder returns a receipt already used for a different item
scope, the helper adds `conflict` / `identity_mismatch` to `items` and
continues. The recorder has already been called for that item. These receipts
are bank evidence, not payment-success writes.

## Capture sandbox invoices

Create `createCapturedPostgresInvoiceProvider(executor, { enabled: true,
providerRef })` and `createPostgresInvoiceAccountHistory(executor)` from
`@openlup/platform/invoicing/postgres`. Pass `captured.provider` to the native
issue job with the seller and payment bindings above. Compose
`createInvoiceAccess` from `@openlup/platform/account-support` with
`{ accountHistory: historyPort, artifacts: captured.artifacts }` for customer
history and download calls.

The captured provider persists a full-identity receipt and visibly non-fiscal
test PDF in an append-only artifact observation. Replay, including through a
new provider instance, reuses the receipt. Disabled or foreign selections return
`unsupported` before SQL. Conflicting facts or identity return
`identity_mismatch`; clearance-required facts return `blocked`. Failed reads
remain unknown. Unprepared claims cannot insert a receipt. Remote void and
artifact `persist` are unsupported: receipt creation owns those bytes. This
composition performs no external fiscal issue, submission or email delivery.

Pass the authenticated principal UUID as `accountRef`, never a client ID or a
request-body ownership claim. The history query joins principal ownership to
the order while selecting documents. It includes pending and voided documents,
stored currency, signed correction amounts and parent identity.
`createInvoiceAccess` independently checks history membership before resolving a
download ticket. Missing artifacts remain unavailable. Artifact-only reads
require prior authorization by your application.

## Check your adapter

Use `runInvoiceAdapterConformance` with the selected provider, descriptor,
offline fixtures and a counter for writes across every injected transport.
Cover supported writes and replay, unknown recovery without writes, exact
scoped absence, correction parent mismatch and unsupported operations. The
checks validate those assertions; they do not establish fiscal certification
or live provider behavior.

## Freeze the invoice buyer

Install the complete catalogue including first-duty buyer capture before
composing native invoicing. The first original owed duty freezes one immutable
buyer component atomically, including when payment truth captures the duty.
No opt-in callback is needed. Selection preserves order buyer facts first,
then the owned default/latest billing profile and billing-or-both address,
then the marked shipping fallback. Paid sources read the order destination;
handoff sources read the order-owned parcel destination. Replays never backfill
an earlier duty or document, even if full fiscal facts are still absent.

Select `createPostgresBillingInvoiceStore` for fiscal composition and call
`readCapturedBuyer(orderId)` for that component. Its fact installer rejects a
buyer that contradicts the captured component. Installing full fiscal facts
is a later operation, not the buyer-freeze point. Retained-source collection
uses the same capture boundary.

Capture refuses a missing recorded destination with
`commerce_destination_unavailable`; record that owned destination before retry.
A handoff naming a foreign shipment refuses with
`customer_billing_shipment_mismatch`. Correct source faults while retryable.
After the sweep's attempt ceiling marks a source `faulted`, no supported
operator reset/requeue command exists; seek an invoicing-owned recovery
procedure without editing ledger rows. Capture does not fabricate an address.

`InvoiceBuyer` permits optional second address line, raw identifier and
provenance fields. Provider projection preserves those fields and profile/address
references when present; older input gains no fabricated fields. Your host still
owns identifier normalization, fiscal kind, clearance, money, lines and seller
policy. A full fact revision is immutable. Editing a profile cannot change an
existing request, issued bytes or replay; later requests can use the edited
profile. Existing duties and facts without a buyer component remain unchanged.
This path installs no provider executor or scheduler and applies no checkout
defaults.

Compose the billing privacy contributor described under
[billing profiles](account-and-support.md#manage-billing-profiles). Frozen buyers
remain retained invoice data; identity erasure does not erase invoices or supply
their retention/processor policy. Finite native transfer preserves components
exactly after their duties; it does not activate the target.
