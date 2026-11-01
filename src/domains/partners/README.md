# Partners domain

Partners owns B2B/private-label inquiry contacts and partner pipeline facts.
A captured contact and pipeline `closed_won` establish neither a customer
identity nor marketing permission. Customer lifecycle belongs to `clients`;
tester participation, commerce and communications retain their own owners.

## Public surface

The existing `@openlup/platform/marketing` entry exports strict inquiry submit
and `partner_acquisition_v1` case/list/transition schemas. Its type-only
`marketing/contracts` entry exports their DTOs and `PartnerAcquisitionPort`.
`marketing/server/postgres` exports `createPostgresPartnerAcquisitionPort` for
submit, list, transition and close. The status vocabulary and legacy status
update shape retain the `@openlup/core/partners` owner. This packaging location
does not change Partners' domain or data ownership.

R1 contributes these neutral contracts and the unchanged store. The reference
`contracts.ts` and `ports.ts` still contain neutral compatibility definitions
alongside the richer inquiry/list/status shapes; the source adapter remains
until separate R2 thin delegation. Rich managed inquiry rows, CRM identifiers,
provider evidence and managed admin transitions stay application-owned.

`publicB2BInquiryClient.ts` submits the seven form fields through the typed BFF
client and carries the host's idempotency header. `adminB2BInquiryClient.ts`
uses the distinct managed list/status contract. The public strict submit
property is `openlupInternalCheck`; a host with another sentinel spelling must
map it explicitly at its compatibility seam, retaining silent-check behavior.
The form admits country `OTHER` and leading-zero phone values that direct SQL
refuses. R1 preserves these existing refusal boundaries rather than tightening
form/schema admission or silently widening SQL.

## Store and host ownership

The package preserves text/email/country/phone normalization, twelve submit
arguments, role selection, transaction order, rollback/release, lazy pool
ownership, original command receipts, quotas, descending cursor tuples and
expected-version transition fences. Its three existing routines use the
restricted `platform_acquisition_runtime` role. Actor UUID presence is not an
administrator membership check. The host owns wire validation, explicit neutral
list-view selection and authorization before resolving the binding.

Reference BFF leaves live under `server/bff/partners/` and
`server/bff/admin/partners/`; runtime selection and connection cache live under
`server/runtime/partners/`. HTTP method checks, administrator authorization,
legacy drain, environment selection, routing and disposal stay with the host.
The public `api/bff/[...path].ts` dispatcher currently has an empty route table.
A leaf handler or logical `/api/...` coordinate establishes source existence,
not a serving endpoint. Importing the package activates no route or executor.

Install the complete selected [source catalogue](../../../docs/platform/DATA_AND_MIGRATIONS.md#partner-acquisition-data).
Its four existing partner units are already in all three source plans; sparse
npm SQL assets do not constitute a complete partner installer. R1 changes no
SQL, grants, objects or catalogue hashes. An adopter with existing compatible
SQL keeps its objects; package consumption does not authorize replacing them.

## Personal data and unavailable coverage

Partners owns resource duties for acquisition contact email/phone, organization
and person names/notes, case/contact references, persisted command result
projections, audit actor/case references and keyed fingerprints. These duties
include original receipt projections containing personal data. Keep the private
installation key secret; it is not a subject-export resource.

Partner export/erasure implementation is unavailable. Existing
marketing privacy-contributor coverage does not establish partner coverage or
completeness. No append-only command/audit rewrite is introduced. A broader
privacy claim requires an explicit resource disposition and owning
implementation. Existing transfer admission refuses nonempty acquisition
business state; no partner transfer capability is added.

## Evidence and availability

The [package contract witness](../../../packages/platform/test/marketing/partnerAcquisition.test.ts)
freezes literal schema expectations; [public counterpart and producer proof](../../../tests/platform/partners/partnerAcquisitionParity.test.ts)
checks the actual form model/client and strict sentinel behavior. The
[real PostgreSQL witness](../../../tests/postgres/partnerAcquisition.test.ts)
packs the current artifact, compiles supported exports in both declaration
modes, and executes the default factory against the current complete native
catalogue using a separate non-superuser runtime login. It freezes ten behavior
classes and cross-port persisted state; missing Docker fails this proof.
These witnesses establish no provider integration, hosted qualification,
customer conversion, opt-in, route availability or release authority.

See [architecture](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md),
[canonical contracts](../../../docs/platform/CANONICAL_CONTRACTS.md#partner-acquisition)
and the [R1 task record](../../../docs/platform/plans/oss-m18-r1-partner-acquisition.md)
for the contribution and later-phase boundaries.
