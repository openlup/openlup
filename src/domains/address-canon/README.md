# address-canon domain

Hidden, provider-neutral address-directory lookup: given a postal code, return
ranked locality candidates; given a locality, return its streets. It exists so a
checkout or account form can *assist* an address entry without guessing, and it
is deliberately a read-only directory rather than a validator.

⚠️ This README is the whole documentation for this domain. Nothing about it is
covered by the maintainer canons in the private overlay.

## Owns / does not own

- **Owns:** the canonical postal-code, locality and street lookup contracts;
  ranked candidates with an explicit confidence and resolution level; and the
  source/provenance metadata that says which directory a record came from and
  how current it is.
- **Does not own:** customer address rows, checkout selection, the autocomplete
  UI, directory imports, source licensing, or any live external API call. The
  adapter reads tables in this deployment's own database; nothing in this domain
  calls a registry at request time.

The domain returns candidates rather than a single answer because a postal code
does not map to exactly one locality. The canonical form fields elsewhere in the
tree stay format validators; this is a later data-assist layer on top of them.

## Ports and seams

- `contracts.ts` — request/response schemas, the candidate shape, and the
  source/provenance types.
- `ports.ts` — `AddressCanonLookupPort`, three methods: `lookupPostalCode`,
  `searchLocalities`, `listStreets`. This is the seam an adopter implements to
  supply a different directory.
- `addressCanonClient.ts` — the browser client. No current UI imports it;
  autocomplete activation is a later checkout/account wave.
- `server/domains/address-canon/addressCanonLookupHandler.ts` — the neutral
  handler, with `ports.ts` there re-exporting this domain's port type.
- `server/adapters/supabase/address-canon/addressCanonLookup.ts` — the managed
  implementation of that port.
- `server/bff/address-canon/{postal-code,localities,streets}.ts` — the three
  hidden route handlers, reached at `/api/bff/address-canon/*`. There is no
  `api/bff/<name>` directory: `api/bff/[...path].ts` is one router for every BFF
  path.

## What an adopter configures

- `COMMERCE_ADDRESS_CANON_LOOKUP_ENABLED` — the only flag. All three routes are
  off unless it is `true`; there is no partial enablement.
- The directory data itself. The adapter reads `address_canon_localities`,
  `address_canon_postal_localities`, `address_canon_streets` and
  `address_canon_sources`, created by
  a deployment-provided migration under the contract in `docs/platform/DATA_AND_MIGRATIONS.md`.
  Empty tables are not an error — the lookup simply returns no candidates. There
  is no importer in this tree, so populating them is the adopter's job.
- Nothing else: no credential, no base URL, no rate limit. A lookup is a read.

## Known non-neutrality (this deployment)

Honest inventory, so an adopter is not surprised:

- The contract pins `countryCode` to the literal `"PL"`, and the postal-code
  schema accepts only the five-digit `NN-NNN` form. A second country needs a
  contract change, not configuration.
- The source vocabulary — `gus_teryt`, `gugik_prg`, `poczta_pna` — names three
  national directories of one country. They are this deployment's integrations,
  not a platform concept, and they appear here only as provenance labels.
- `disabled_pending_license` is a first-class source status because one of those
  directories is licensed and may not be redistributable. A source row can
  therefore be present and deliberately unusable.

A record stored under this domain keeps only an opaque source, reference,
revision and provenance fact. It does not republish a licensed directory and it
does not persist raw address fields of its own.
