# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.27.0]

- Publishable on the npm `latest` dist-tag as `0.27.0`, from tag
  `openlup-platform-v0.27.0`.

- Bind experimental native new-purchase previews to the existing ATP reader through the inventory and reference composition, protecting subscription stock without another stock calculation.
- Migration: PostgreSQL hosts supply the optional `stockSourceKey` binding dependency to enable `newPurchaseStockReadPort`. The preview then binds with no unsupported reason; an absent or blank key reports `inventory_stock_source_key_required`. Admin readiness is unchanged; a required preview leaves reference readiness refused until the key is supplied.
- Migration: Native previews subtract all live holds, remaining active subscription demand inside 14 days and channel exposure. For 20 units with 5 held and 7 still due, both availability fields report 8; a provider-tag-filtered preview counting only 2 of those held units would report 11 for new purchases. Credited own-cycle holds are not subtracted twice. Exposure of 4 reduces a budget of 11 to 7.
- Migration: Native budgets clamp at zero, stale stock contributes zero to ATP, and local-only stock has no native source. The native preview refuses own-order exclusions or a horizon other than 14 days as `native_stock_read_options_unsupported`; it provides no one-time or replacement allocation seam.
- Migration: Managed hosts apply the managed forward `20261025109000_inventory_new_purchase_stock_read.sql` after the managed migration prefix (`public.inventory_new_purchase_stock_read(p_skus jsonb, p_as_of timestamptz) RETURNS jsonb`, service_role-only execution), then supply optional `stockRpc` to the inventory binding (also forwarded through the reference store). An injected `newPurchaseStockReadPort` wins; without either dependency the existing `inventory_new_purchase_stock_reader_required` remains.
- Migration: Managed preview quantities equal ATP with renewal exemption fixed false, preserving M10 provider-tagged holds, safety, 14-day uncredited demand and channel exposure. Both availability fields now include demand and clamp at zero. Other horizons and own-order exclusions refuse `managed_stock_read_options_unsupported`; SQL accepts at most 200 requested array items before deduplication and refuses a NULL as-of timestamp as `inventory_stock_as_of_invalid` (SQLSTATE `22023`). The managed preview treats ANY stale provider-stock evidence for the SKU as stale (fail-safe; exact when one provider kind exists); quantities remain unchanged and the allocator's own stale refusal stays authoritative.
- Migration: Managed `source` is "provider" iff ATP returns a row for the SKU; otherwise it is "missing".

- Add experimental `@openlup/platform/commerce` neutral schema cores, contract helpers and ports, plus type-only browser-safe `@openlup/platform/commerce/contracts`. Reference bindings extend these cores with existing profile, locale, fiscal and provider policy. No version or artifact cap changes.
Migration: Commerce-owned ports and generic records may be imported from `commerce/contracts`. Pricing DTOs remain at `@openlup/platform/pricing/contracts` directly, without convenience re-exports from commerce. Reference exported names remain available.
Migration: `commerceOfferVersionSchema` now validates opaque offer tokens of at most 40 characters, using the lower-case token grammar (D1).
Migration: The commerce quote port's out-of-band `CreateQuoteOptions` now accepts the server-bound `offerVersion`; the M05 options and quote DTOs remain their existing owner (D2).
Migration: Reference quote context types additionally carry optional shipping and acquisition terms using their existing package definitions (D3).
Migration: Checkout expected-quote acceptance and price-change responses now admit acquisition expectations independently of totals; invalid revisions and discount bounds are refused (D4).
Migration: Configurator intents additionally admit acquisition capability, opaque `offerVersion` and bounded `minimumUnits` asks (D5).
Migration: A supplied minimum replaces the injected host default for untrusted intent validation only; it does not authorize server checkout admission (D6).
Migration: `offerAvailabilityRequestItems` projects one unit per variant in input order and the supplied checkout mode (D7).
Migration: The reference configurator-to-quote mapper forwards an admitted acquisition capability, leaving absent capabilities absent (D8). This does not activate an acquisition issuer or offer guard.
Migration: `CheckoutOfferPolicyPort<Intent, Quote>` and its bound/refused result are available as types only (D9). Offer resolution, evidence execution and the starter guard remain outside K1 and are deferred to K2a.
Migration: Reference recovery policy, nominal errors and order-contact helpers delegate to the package with identity preserved. Neutral checkout, resume and defaults schema factories require explicit host bindings; their reference extensions retain existing acceptance, parsed output and error paths.
Migration: `commerce/server` is a reserved empty Node-only entry; browser consumers continue to use `commerce` and `commerce/contracts`. Canonical order-money and commerce outbox payload validation are available from `commerce`; host quote/draft schemas are injected with the existing validation behavior.
Migration: Checkout admission refuses unbound offer/minimum asks while no server offer resolver is composed, retaining the host floor for ordinary requests; untrusted intent parsing still accepts those asks.
Migration: The commerce quote port requires request, response and host-options type parameters; the reference binds the existing pricing definitions and retains its named types. This removes an unnecessary pricing declaration closure without copying its contracts or changing pricing behavior.
- Add browser-safe `@openlup/platform/pricing/browser` with direct re-exports of the existing quote primitive factory and acquisition capability/expectation schemas. Reference imports retain symbol identity and validation behavior; the pricing root and contracts entry are unchanged.
Migration: Regenerated `communications.api.md`, `fulfillment.api.md` and `inventory.api.md` change declaration order only: TypeScript emits union and enum members in literal-creation order across the program. For `defaultCommunicationPurposeRegistry`, before: `"transactional" | "marketing_launch_offer" | "marketing_newsletter" | "tester_program" | "subscription_dunning" | "admin_notification"`; after: `"transactional" | "subscription_dunning" | "marketing_launch_offer" | "marketing_newsletter" | "tester_program" | "admin_notification"`. Communications newsletter, fulfillment and inventory enum members likewise appear in a different order. The member sets and all types are unchanged; type consumers are unaffected and need no code or SQL migration.

- K2 lands no SQL. A dedicated later PR, L1, lands all nine reviewed managed M11 slots (`scripts/fixtures/reviewed-m11/supabase/migrations/20261025100000..110000`) in order; no release ships K2 without them (D-M11-SQL-LAND-1).
- Until L1 lands on the managed rail, a 21-day starter graduation cadence passes admission but fails at provisional-subscription creation: the installed `subscription_create_provisional_for_checkout` and `subscription_apply_starter_graduation` still accept only 14 and 28. Checkout returns the generic failure (HTTP 503).
- Until L1 lands on the managed rail, the finalize acquisition-admission backstop is inert: `commerce_finalize_order_for_checkout` does not invoke `private.commerce_assert_acquisition_admission` to raise `acquisition_terms_changed` (SQLSTATE 55000), so the package mapping and the safe-compensation re-quote it triggers never fire from the database. The TypeScript quote guard still re-quotes a changed acquisition expectation before finalize.
- Until L1 lands on the managed rail, `commerce_configurator_persist_intent` lacks the donor preference write scope: preference/consent writes are not restricted to the authenticated owner, and the legacy country fallback stays as installed.

- Move the unchanged checkout compensation helper and cleanup port into `@openlup/platform/commerce/server`. The reference facade re-exports the identical function; release/cancellation ordering, idempotency keys, reasons and warnings are unchanged.

- Move checkout handlers, the shared paid-order saga, runtime and command execution into the experimental Node-only commerce entry. Host projections, schemas, response routing, starter policy and existing payment execution are injected; reference paths delegate to one package implementation.
Migration: Acquisition expectations independently reject changed terms in the TypeScript quote guard before finalize; a locked finalize refusal re-quotes only after safe draft compensation once the managed forwards land (L1) (N1). Shipping or acquisition terms now require promotion acceptance even without a current promotion discount (F2).
Migration: Failed promotion-price-change re-quotes now map `CommerceQuoteError` code `UNKNOWN_SKU` to `BAD_REQUEST` (HTTP 400), and `PRICE_NOT_CONFIGURED`, `UNSUPPORTED_TAX_PROFILE` or `PRICING_INVARIANT_VIOLATION` to `CONFLICT` (HTTP 409), forwarding `error.message` and `error.details` instead of the base's `UPSTREAM_UNAVAILABLE` (HTTP 503), "Checkout failed" and `{ feature: "checkout", stage: "quote" }`. Newly supported acquisition-terms-change re-quotes use the same typed mapping (donor N1).
Migration: Failed promotion-price-change re-quotes with `CommerceQuoteCatalogReadError` retain `UPSTREAM_UNAVAILABLE` (HTTP 503), but now return "Commerce catalog is unavailable" and `{ reason: "catalog_unavailable", refusalCode: error.code }` instead of the base's "Checkout failed" and `{ feature: "checkout", stage: "quote" }`. Newly supported acquisition-terms-change re-quotes use the same catalog mapping (donor N1).
Migration: Initial quotes, including normal quoting after saved-continuation fallback, and promotion-price-change re-quotes now map `AcquisitionTermsError` reasons `acquisition_terms_capability_required` and `acquisition_terms_v2_required` to `CONFLICT` (HTTP 409), "Acquisition terms unavailable" and `{ reason: error.reason, refreshRequired: true }`. The base returned `UPSTREAM_UNAVAILABLE` (HTTP 503), "Checkout failed" and `{ feature: "checkout", stage: "orchestrate_order" }` with an optional sanitized preview `diagnosticReason` for initial quotes, or `{ feature: "checkout", stage: "quote" }` for promotion re-quotes. Newly supported acquisition-terms-change re-quotes use the same acquisition mapping (donor N1).
Migration: On those initial/continuation and promotion re-quote paths, `AcquisitionTermsError` reasons `acquisition_terms_policy_unconfigured`, `acquisition_terms_invalid`, `acquisition_terms_ambiguous` and `acquisition_terms_not_effective` retain `UPSTREAM_UNAVAILABLE` (HTTP 503), but now return "Acquisition terms unavailable" and `{ reason: error.reason, refreshRequired: false }` instead of the base's "Checkout failed" and initial-quote orchestration/preview or promotion re-quote stage details described above. Newly supported acquisition-terms-change re-quotes use the same acquisition mapping (donor N1).
Migration: An offer-version or minimum-units ask requires a server offer-policy binding. Without a resolver, reference admission retains its host minimum and original validation refusal before persistence. A composed resolver binds or refuses before any quote, order-draft or runtime write; identity persistence retains its existing earlier ordering. Accepted evidence is bounded and the bound version follows authoritative, steady and replacement quotes (N2).
Migration: An owned saved acquisition quote may continue before re-quoting only when subject context, basket, total, terms, contact, invoice, delivery and starter state match exactly; edits and failed/incomplete lookups take normal quoting (N3).
Migration: Scoped inventory admission contention returns retryable unavailability without provider dispatch or compensation capability; retry identities are unchanged (N4). Raw database error classification remains an adapter responsibility.
Migration: Starter admission accepts injected terms and a supplied graduation constraint, includes the 21-day graduation cadence, compares acquisition revision and rate, and freezes the selected second-delivery discount with steady quote policy/version (N5). Reference starter defaults remain host inputs. End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: The best-effort account-link helper accepts an optional trigger for its existing timeout log; without a trigger its log and timeout behavior are unchanged (N8).
Migration: Saved-method alias and recurring-mode metadata are host-defined string generics throughout the checkout resolver, handler, orchestration, command and runtime APIs. Reference bindings retain their existing provider unions, wire values and execution behavior.
Migration: The offer-evidence JSON-length limit is internal; consumers use the exported evidence schema.
Migration: The reference browser quote context now admits optional shipping and resolved acquisition terms through their existing validators, preserving strictness and existing fields (donor D3; K1-scope port carried by K2). `pricing/browser` re-exports the identical schema objects without new validation logic.
Migration: `outbox.commerceOrderDraftCreatedEventSchema` now accepts the 21-day starter cadence at `payload.quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`, `payload.orderDraftSnapshot.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `outbox.commerceOrderDraftCreatedOutboxRecordSchema` now accepts the 21-day starter cadence at `payload.quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`, `payload.orderDraftSnapshot.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `outbox.commerceOrderDraftCreatedPayloadSchema` now accepts the 21-day starter cadence at `quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`, `orderDraftSnapshot.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `checkout.checkoutRequestSchema` now accepts the 21-day starter cadence at `intent.starterOffer.steady.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `checkout.checkoutResponseSchema` now accepts the 21-day starter cadence at `authoritativeQuote.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.commerceQuoteSchema` now accepts the 21-day starter cadence at `context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createOrderDraftRequestSchema` now accepts the 21-day starter cadence at `quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createOrderDraftResponseSchema` now accepts the 21-day starter cadence at `orderDraft.quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createQuoteBatchResponseSchema` now accepts the 21-day starter cadence at `quotes.0.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createQuoteResponseSchema` now accepts the 21-day starter cadence at `quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.orderDraftSummarySchema` now accepts the 21-day starter cadence at `quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.publicCreateQuoteBatchResponseSchema` now accepts the 21-day starter cadence at `quotes.0.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.publicCreateQuoteResponseSchema` now accepts the 21-day starter cadence at `quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.quoteContextSchema` now accepts the 21-day starter cadence at `starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.starterPackPlanSchema` now accepts the 21-day starter cadence at `graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `intent.configuratorIntentSchema` now accepts the 21-day starter cadence at `starterOffer.steady.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `persistence.configuratorIntentPersistenceRequestSchema` now accepts the 21-day starter cadence at `starterOffer.steady.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: The reference subscription starter-marker reader now also accepts the 21-day graduation cadence, matching the checkout starter plan; 30 days remains refused (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).

- Move generic draft/finalize/intent/resume stores, cancellation and sweep adapters, bounded recovery classifiers and token helpers into `commerce/server`. Reference factories inject existing schemas, ordered arguments, response projections and phone normalization; verified subject stamping remains last. Recovery projection/routes stay reference-owned; the C2 release handoff is to be released.
Migration: Runtime-finalize `acquisition_terms_changed` now retains its scoped conflict reason; database-triggered safe pre-dispatch draft compensation and repricing become reachable once the managed forwards land (L1) (N1).
Migration: Draft catalog-head-moved, missing-anchor and offer-membership refusals now map to catalog-admission conflicts without superseding a draft (N1).
Migration: Expired subscription recovery permits an absent host subject only with the exact persisted neutral-command marker and all other eligibility fences; public runtime schemas gain no marker bypass (N6).
Migration: Recovery commercial fingerprints now include shipping terms version, currency, flat charge and threshold; same-money policy drift refuses recreation (N6).
Migration: The token-state classifier permits continuation only for active/order-not-recoverable, separates expired-policy handling and refuses revoked/used/missing/unknown states. Retained routes are not rewired by this addition (N7).
Migration: `StarterDeclaration` stays internal to the checkout engine; derive a declaration type from the `createStarterOfferGuard` binding signature instead of importing a standalone type from `commerce/server`.

- Add the unchanged physical-table offer-availability projection at `commerce/server` over a structural client and explicit provider predicate, and the pure status/reason ladder at browser-safe `commerce`. Reference adapters retain SDK/provider policy and delegate to the one package implementation; M06 retains normalized stock reads and reservation TTL ownership. No preview ATP switch or second allocator.
Migration: The reference reservation binding now maps protected inventory `55P03` failures to scoped `inventory_admission_busy`/`inventory_lock_unavailable` details, refuses schema fallback under contention and preserves the original retry keys (N4). Checkout exposes the existing retryable refusal before dispatch; no compensation capability is fabricated.
- Give structural draft, resume, intent and compensation factories neutral RPC/query names. Reference bindings retain their incumbent exported names and behavior.

- Add experimental neutral OMS schema cores, browser-safe DTOs and ports, generic handler factories, read builders and managed adapters through the existing commerce entries. Reference wrappers bind identity, settlement, fiscal fields, governance and provider projections. No versions, SQL, migrations or pack caps change.
Migration: Host integrations supply `respond`, `authorizeAdmin` and optional read-gate/schema bindings. Mutation request parsing and response envelopes use the donor shared helpers; invalid results remain 502, nominal conflicts 409 and upstream throws 503 with their existing messages.
Migration: Managed clients are structural and RPC-only; query hydration and idempotent note persistence require a separately injected query capability. Manual refund marking calls only the operator-mark RPC and creates no refund.
Migration: Neutral read contracts omit private identity and first-cycle presentation, use open provider/accounting status strings, a neutral fiscal field and neutral provider counter. Hosts extend the schema and pass projections through final validation to preserve their existing response fields and acceptance.
Migration: The reference replacement facade now delegates to the existing fulfillment handler instead of its local handler engine. For managed results, request parsing, success bodies (including defaulted released hold IDs), replay receipts, metadata, idempotency keys, RPC arguments, receiver identity, named 409 refusals and ordinary 400/401/403/405/502/503 responses are unchanged. The fulfillment handler additionally recognizes the native-unsupported sentinel and returns its specific 503; the old local handler would classify that sentinel as an invalid 502 response. The managed adapter does not emit this sentinel. Neither path creates a refund or confirms delivery alignment.
Migration: Default neutral settlement validation checks a three-letter currency and labels empty totals with `XXX`; hosts inject their actual acceptance/default policy. Delivery summaries and labels use neutral defaults until the host supplies its projections.
Migration: Browser-safe `./commerce` exports schemas and pure helpers; handlers, managed RPC/query adapters and detail composition now import from the Node-only `./commerce/server` entry. `./commerce/contracts` remains type-only.
Migration: Unprojected OMS timeline labels now use canonical step keys (for example `delivered`) instead of the reference locale labels. Unknown tokens retain `Delivery status updated`; reference presentation remains behind the existing `timelineLabel` projection. Managed query clients must implement the required `is(column, value)` filter for hydration; class query receivers are preserved by the adapter factory.
Migration: Omitted fulfillment debug now defaults to `No fulfillment data.` in neutral detail schemas. The reference schema binding retains its previous localized summary and serialized field order.
Migration: Commerce no longer re-exports the core locale label helper `timelineLabelForStep` or the label-bearing `FULFILLMENT_STATUS_MAP`. Presentation consumers import these from their core owner or host binding; commerce retains pure canonical step and recovery helpers.
Migration: OMS binds K1 order-money and paid-event exports directly. The concrete OMS payment type is `OmsOrderPaymentStatus`, using K1's unchanged generic `OmsPaymentStatus<PaymentIntentStatus>`. Fulfillment recovery DTOs are commerce-owned alongside their pure recovery helpers.
Migration: Regenerated `commerce.api.md`, `commerce-contracts.api.md`, `commerce-server.api.md`, `communications.api.md`, `fulfillment.api.md` and `identity.api.md` reflect this final declaration graph. Beyond the commerce additions described above, existing declarations change order only: newsletter event `ignored`, fulfillment status members and identity lifecycle-stage members move within their existing declarations. Before and after member sets and types are identical; consumers need no code or SQL migration for this ordering.
- @openlup/platform size growth: Neutral OMS read model, handlers, managed adapters and contracts moved into `@openlup/platform/commerce` and the new Node-only `./commerce/server` entry, together with the rest of the M11 commerce stack; K1+K3a measured 1,562,728 packed bytes; adding K3b, K4, K2 (K2a x1.4) and F3 projects 1,749,300 packed bytes; caps raised once with 10% headroom to 1,925,000 packed bytes, 1,648,000 code-gzip bytes, 8,970,000 unpacked bytes, 2,520 code files and 2,580 total files (K3a PR #370, cap-raise commit 5e42e9ec).

- Add experimental returns, native order review/media and separate hosted-feedback contracts at `@openlup/platform/commerce`, with handlers and adapters at `@openlup/platform/commerce/server`. Reference paths remain thin facades; no route, SQL, activation or release is added.
- Migration: Import returns and native order-review/media handlers and adapters from `@openlup/platform/commerce/server`; schemas and port declarations remain at `@openlup/platform/commerce`. Standalone returns handlers require an injected `BffResponder`; reference handler signatures and observed response context are preserved by their facades. Raw upload HTTP types now use the equivalent package HTTP shapes.
- Migration: Hosted-feedback schemas and RPC-name constants are available from `@openlup/platform/commerce`; Supabase submit/token-check factories are at `@openlup/platform/commerce/server`. Adopters must supply `submit_order_feedback` and `check_order_feedback_token`; native `db/platform` has neither RPC. Hosted feedback remains distinct from native order reviews.
- Returns scope (F9): only request, approve and reject exist. `restockDisposition`, `refundMode` and `refundAmountCents` record intent; receive, restock and refund execution were never implemented. Request owner/key/fingerprint enforcement stays in the database; the contributed TypeScript RPC arguments are unchanged.
- Native handler donor-ahead command-runner contribution is observably identical to the prior inline handlers: the 96 pre-move result pins pass, including admin error mapping and exact `replayed` presence. No behavior migration arises from this command-runner contribution.
- HOST-OWNED class (b) retention: review delay is SQL-only, 14 days native and 21 days in the contributed managed profile. No TypeScript delay seam or SQL change is included.
- Media retains its existing private storage/upload seams. M02 blob storage lacks private read, inspection, temporary write and promotion operations, so a behavior-changing bridge is not included.
- Migration: The package default returns reason set is neutral. Use `createCommerceReturnsSchemas(reasonCodes)` and the customer handler's `requestSchema` dependency for host policy; the reference keeps the legacy set with BASE-identical parsed output, refusal details and responses. Return request/approve/reject RPC behavior is unchanged.
- Migration: Reference browser review and hosted-feedback facades restore jitless Zod initialization before package schema construction. This restores BASE/donor CSP behavior without adding global configuration to the package modules.
- Migration: `runOrderReviewCommand` is internal to the package. Import the customer/admin handler factories from the commerce/server entry; the reference customer-handler facade keeps its BASE factory export.
- Migration: Handlers, adapters and raw upload use the existing `@openlup/platform/commerce/server` entry. The `./commerce` runtime graph is browser-safe; `./commerce/contracts` stays type-only. Reference import paths and observed behavior are unchanged.

- Add experimental Node-only commerce domain-effect consumers at `@openlup/platform/commerce/server`; browser-safe event contracts, projections and ports stay at `@openlup/platform/commerce`. No new executor, emitter or dispatcher.
- Record omitted adopter-private W8/W9 assertions and their owners in the [reference commerce guide](../../src/domains/commerce/README.md#w8w9-conformance-dropped-adopter-private-assertions).
- Migration: Import handler factories, registry composition and `CommerceEmailRuntime` from `@openlup/platform/commerce/server`. The browser entry never imports the server entry or M08 runtime.
- Migration: Reference email handlers and the dispatch registry bind a single neutral implementation. Package ports use `contextName` and `messageId`; reference adapters retain their existing extension/provider fields and public send behavior.
- Migration: `uniqueRegistry` is injected from the existing outbox rail, with no new package dependency. `CommerceEmailRuntime` requires explicit communications parser, transactional scaffold, outcome mapping, locale, money, line-label, paid-presentation, tracking and notification-policy bindings. Reference locale, formatting, provider outcomes and legacy tracking URLs remain unchanged.
- Migration: Refund notices display amounts only with `refundEvidenceVersion: "provider-refund.v2"`; historical order totals and unversioned refund amounts no longer appear as refund evidence (donor-ahead).
- Migration: The frozen refund consumer subset ignores legacy `totalCents` and admits optional string `refundEvidenceVersion`; supplied refund amounts and currencies retain their existing validation.
- Migration: Paid-receipt presentation forwards its proved discount percentage, including non-default percentages (donor-ahead); commercial eligibility stays with the host.
- Migration: Core handler descriptors and expected-descriptor validation are available before claiming. Claim order, flags, independent paid-email/fulfillment duties, same-event timeout composition and risk gating retain donor behavior.
- Migration: Channel-owned buyer communication settles as processed with `skipped: "channel_owns_buyer_comms"`, using a live policy read per event. Cancellation email remains unregistered; its fact can be consumed through adopter `extraHandlers`.
- Migration: Producer event-type literals and payload schema behavior remain unchanged; the draft-event factory accepts exact host snapshot schemas. The neutral source projection preserves external-reference bytes and case, with no inventory SQL or exposure default.
- Migration: Reference email payload parsing binds the existing fulfillment `parseOutboxPayload` export; its schema issues and bounded discard reason are unchanged. K1 owns all producer schemas through `createCommerceOutboxEventSchemas`; all nine golden parse/refusal cases pass unchanged.
- Migration: Paid-fulfillment registration re-exports the existing fulfillment descriptor, preserving its identity, event literal and timeout instead of maintaining a second descriptor.

- Add an experimental structural commerce contribution at the existing composition entry, with explicit installed commerce exports, namespaced ports and existing handler, route and schedule descriptors. Duplicate registrations refuse before maps can overwrite an executor.
- Add an inert, default-off reference commerce binding over existing package callables and the existing native checkout-recovery adapter. Only ready schema observations admit work; unknown and unsatisfied candidates leave the serving selection intact. Native recovery records reminder intents, authorizes their delivery and compacts terminal outbox rows; managed-only expiry and recreation remain separate.
- K5 adds no refactor: the event-contract gap and server entry scaffold are already resolved in the preceding imports. Existing commerce witnesses and engines remain unchanged; no SQL, timer, route activation or second executor is introduced.
Migration: `@openlup/platform/composition` additively exports `createCommerceContribution`. Supply the selected callables, complete required schema and existing descriptors; the factory declares them without installation or execution. Existing imports and default compositions need no change.

- Managed commerce migrations preserve the exact reviewed fixture bytes and ordered prerequisite chain.
Migration: Guest configurator destinations do not rewrite saved delivery or payment preferences; preference writes require a server-proved matching account.
Migration: Legacy omitted-country fallback uses `platform_region_code()` for address identity and insertion; configure the adopter's settlement region. Neutral commands require explicit country.
Migration: Return creation and replay require the server-supplied principal's owned order and identical normalized command; foreign or changed commands refuse atomically.
Migration: Checkout payment-link receipts use the service-only operator entry point and the `checkout_payment_link_mint` audit action.
Migration: Subscription finalize validates retained acquisition terms under the shared policy lock; policy writers require its exclusive counterpart. Completed finalize replay preserves its response after policy changes; one-time checkout is exempt.
Migration: The acquisition terms reader refuses absent effective terms; the no-policy finalize compatibility branch remains available.
Migration: New-purchase stock reads use ATP with renewal exemption fixed false, bounded SKU arrays and conservative stale reporting. The service-only reader uses owner privileges with `SECURITY DEFINER` and `search_path = pg_catalog, pg_temp`.
Migration: Starter graduation admits 14, 21 or 28 days, while provisional creation uses the retained starter interval and subscription timezone default. Rolling back below the forward with a 21-day marker is unsupported; roll forward.

## [0.26.0]

- Publishable on the npm `latest` dist-tag as `0.26.0`, from tag
  `openlup-platform-v0.26.0`.

Managed dunning attempt replay.

Carry the exact applied failure attempt through renewal propagation. Managed
same/stale observations replay the canonical result; newer attributed failures
advance and revoke prior recovery authority, including used tokens.

Migration: `CycleChargeFailurePropagationPort.openDunningCase` now requires nullable `failedPaymentAttemptId`; update host implementations and callers to pass the applied transition's identity.
Migration: `applyFailedResult` may return `paymentAttemptId?: string | null`; return the durable applied attempt so propagation can forward it, including on replay.
Migration: managed hosts must pass exact applied-transition attribution to the new overloads. Fresh missing attribution refuses with SQLSTATE `55000`; do not substitute the current or prepared attempt. Already-applied donor schema/backfill requires the explicit host mapping in DATA_AND_MIGRATIONS.

Native attempt-replay parity remains REGISTERED with M10; these managed forwards
do not implement native parity or authorize host activation.

## [0.25.0]

- Publishable on the npm `latest` dist-tag as `0.25.0`, from tag
  `openlup-platform-v0.25.0`.

- Re-pin the pending M10/F17 control fixtures after landed M08/M09 without
changing either installation rail, the migration manifest or landed N1. The
16-entry packet has seven native and nine managed pins. Native X restores
ATP-counted late-positive stock recovery; Y filters paid retry candidates
before LIMIT. Fold command-preview receipt replay into uninstalled N2, keeping
apply unchanged. Preserve the historical 14-pin approval reader and exact
prefix, definition, statement, ACL and catalog controls. Real PostgreSQL
witnesses cover ATP, starvation, all 43 fresh command scenarios and raw preview
replay with no counts/columns/xmin delta.

No package SQL asset, export, runtime activation or external CI dependency is
introduced. The development-preview boundary remains.

- Fix uninstalled N3 normal_due pagination to exclude waiting/stock_secured cases before LIMIT, preventing normal-renewal starvation.

- Repair uninstalled N2 donor no-op truth for native bundle/resize, plan, package, add-on and same-UTC-day slide commands before repricing: preserve locked prices after catalogue changes, writing only the command receipt, with no quote, event or version increment. Native resize compares lines/cadence; portion mode/factor remain host-owned without native storage. Predicate-removal mutants cover every mapped donor action; apply stays unchanged.

- Audit pending M10 donor change and no-op semantics together. N2 plan edits
apply requested core lines; new add-ons normalize quantity, preserve cadence
and compare UUIDs by value. N3 preserves paused waits, filters eligible recovery
before LIMIT, binds frozen reads to the current active schedule, reports free
stock separately from own holds, and ignores closed/unpaid realization notices.
Real PostgreSQL tables cover applied state, no-op/refusal/replay and rolled-back
assignment mutants. Installed rails and N2 apply remain unchanged; channel
exposure/admission parity stays outside the frozen stock-seam claim.

- Close the 0.24.0 known limitation that managed dunning exhaustion still pauses active subscriptions.
- Land the reviewed managed M1/M2 prefix: refunds preserve subscription lifecycle and paid history; exhausted dunning stays open with NULL retry and active service until authorized same-cycle repair.
- Folded scope E-gate-replay-loop-landed-untested: retain the existing interleaving-aware catalog replay and add the Docker-free landed N1/M1/M2 witness.
- Folded scope D-earlier-pin-digest-unplanted: prove CI and release refuse changed earlier M1 bytes beneath landed M2.

Migration notes: Apply M1 then M2. Existing paused, expired and refund-cancelled history is not rewritten or reactivated. The existing first-cycle refund stock-release guard remains; later refund-evidence parity and stock-wait/winback changes are separate. No runner is activated.

- Add native N2 command preview/apply stores and a P1 command adapter with atomic future terms, actor/key/actual-command receipts and applied/replayed/noop/refused outcomes; preserve frozen current obligations and existing native callers.
- Type-level flip for dev-preview consumers: `NATIVE_SUBSCRIPTION_CAPABILITIES.genericBundleCommands.supported` and `.commandBoundReceipts.supported` change from `false` to `true`; command results now include `SubscriptionCommandRefusal`.

Migration: install N1 then N2 through the complete native manifest; preserve receipts on rollback. Accepted future prices use lock_until_edit, proration none. Address mutation and private introductory/graduation policy stay host-owned; native activation continues to require captured payment evidence.

Migration (C73, temporary limitation): managed `subscription_create_provisional_for_checkout` stamps an explicit timezone literal equal to today's `subscriptions.timezone` column DEFAULT. Adopters changing that DEFAULT must also replace the function until the scheduled follow-up forward follows the DEFAULT; no managed SQL changes here.

Migration: `SubscriptionCommandPort.apply()` may now return `SubscriptionCommandRefusal` (`outcome: "refused"`), so callers must handle it.

- Type-level change visible to dev-preview consumers: `RenewalPaymentRail.execute` adds an optional `failure` field for explicit failure evidence.
- A host or driver skips `openCase` after a replayed `applyFailure` receipt only when that rung's case propagation already committed; otherwise recovery must complete propagation. The P8 retry driver must add a replay/case-advanced signal and a zero-delta witness for replay after committed propagation.
- N2 preview follows the supplied core lines for plan-length changes (omitted lines retain stored expansion); new add-ons normalize missing/nonpositive quantity to one, add-on actions preserve cadence, and quantity updates/removals compare variant UUIDs case-insensitively.

Land the seven reviewed managed stock-wait/ATP and F17 refund-parity forwards.
Managed hosts can use the service-role SQL functions and pgTAP witnesses; the
package declares the SQL surface and keeps TypeScript stock recovery unavailable
because no managed adapter implements the stock-wait/availability ports.

Migration: apply the complete managed prefix through `20261024185100` before
calling stock-wait or refund-evidence functions. M4 extends M2's active/open
continuity with wait exclusion before LIMIT. M5 makes positive customer
cancellations immediately winback-eligible within 120 days, retaining episode
dedupe, and maps started/resumed notices. F17 accepts cumulative provider snapshots,
emits one refunded event on transition, and preserves M1 refund/lifecycle
independence. Keep captured obligations and receipts on rollback and disable the
host stock-wait driver first. SQL installs no scheduler or payment executor.

ATP protects active upcoming demand within 14 days plus live provider hard holds.
The exposure hook remains zero; current donor channel admission is deferred.
This is a development-preview SQL surface, not a composed managed TypeScript port
or a claim of advance future-cycle reservations or stable installation support.

Native stock-wait persistence, frozen discovery and stock-only refusal recovery
now have transaction-bound adapters. The native ATP/new-purchase read protects
hard holds and fixed 14-day soft subscription demand; the renewal allocator uses
the same seam. X restores late-paid released stock once, and Y filters paid and
settled retry obligations before LIMIT. Managed stock wait and runner composition
remain separate; native selection still requires passing real-PostgreSQL proof.

Migration: install the native N3, ATP seam, allocator, X and Y prefix in filename
order, with their package twins and regenerated selected-catalog-v2 inventory.
Migration: upgrading hosts must grant their native inventory-reserving runtime
role EXECUTE on public.inventory_available_to_promise(text,text,timestamptz,boolean)
and public.inventory_channel_exposure_quantity(text,text), plus SELECT on the
seam's underlying relations as listed in Data and migrations, before using the
updated allocator or N3 stock-wait paths.
`StockWaitStorePort.listCandidates` now returns `StockWaitFrozenCase[]`: discovery
may have no durable case yet. Hosts must retain its frozen snapshot and binding.
Frozen discovery requires the active current schedule; paused current waits remain open.
Deficits separate own reserved units from free ATP and subtract both for missing
units. Closed or pending-payment resume callbacks return null without writes; paid
fulfillment-pending orders can complete realization admission.
No advance reservation, physical coverage guarantee or one-time checkout writer
is introduced. No pause, payment execution or parcel-arrival fact is added.
Uncaptured stock refusals rotate on the operation selection timestamp even when
missing or stale stock prevents case creation, allowing replenished work through
a bounded candidate page.

M10 P6 + P8: composed subscriptions (development preview)

Migration: Additive `./subscriptions` facades are `createSubscriptionServices`, `createSubscriptionCommandExamples`, `createSubscriptionLifecycleMessages` and `subscriptionLifecycleTemplate`; hosts explicitly supply readiness, execution, commands and M04 delivery. No factory activates serving work. `SubscriptionLifecycleFact` is exported from this entry; `subscriptionLifecycleTemplate(kind, retryAttempt?)` preserves the installed payment-failure rungs (1, 2, otherwise 3). `runRenewalBatchRows` exposes the existing per-row error-result isolation for composed hosts.
Migration: Additive `./composition` entry `createSubscriptionContribution` describes exactly one selected subscription schedule; off supplies none. Hosts bind its callable to their existing population lease and observe the complete installed schema.
Migration: `createPostgresRetryStore` adds `failureProgress(operationId,key)`, returning receipt replay and committed case progression. The native retry driver completes interrupted propagation and skips already advanced cases; existing applyFailure/openCase signatures remain unchanged.

The inert native reference binding composes mandatory G23, dunning and stock wait.
Captured alignment cases retain authority under off. Prepared attempts reconcile
without re-execution; ordinary retries bind the frozen mandate and logical cycle.
M04 owns delivery; M12 owns aggregation. No SQL asset, serving swap, release or
managed TypeScript recovery is introduced. Native multi-cycle prepaid and M07
prepared-attempt-store capabilities retain their named unsupported boundaries.
