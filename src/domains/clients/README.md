# clients domain

Canonical D2C contact identity over (currently) legacy tester/waitlist persistence + the physical `clients`/`pets`/`addresses` tables: lifecycle, consents, pets, addresses, and the hidden customer-account link.

## Owns / does not own
- **Owns:** D2C contacts, portable customer-360 identity/lifecycle facts,
  addresses, pets, consents, waitlist/tester legacy adapters, soft-account link.
- **Does not own:** tester-program status machine, orders, DHL provider behavior, email delivery.

## Retired acquisition source

⚠️ The tester/waitlist acquisition programme is **ended**. Historical contracts,
handlers, and administrative shapes remain in this source tree while retirement
is completed; they are not an importable public-platform capability:

- Public admission: `publicTesterSignupContracts.ts`,
  `publicTesterSignupClient.ts`, `publicTesterSignupPorts.ts`,
  `publicWaitlistContracts.ts`, `publicWaitlistClient.ts`,
  `publicWaitlistPorts.ts`.
- Admin lifecycle: `adminTesters*`, `adminTesterDetail*`, `adminTesterCreate*`,
  `adminTesterUpdate*`, `adminTesterPorts.ts`, and `adminWaitlist*`.
- Their server handlers and BFF route implementations.
- Managed rich tester DTOs.

At this commit, the source dispatcher retains the logical
`/api/bff/clients/tester-signup` and `/api/bff/clients/waitlist` coordinates,
but their terminal handlers return `NOT_FOUND` before parsing, configuration,
database, or delivery side effects. That source-route fact neither makes the
retired action available nor proves that any deployment mounts or exposes it.
What survives the retirement is history: the neutral acquisition case below,
plus the admin identity reads.

## Public surface (import cross-domain ONLY these)
- Portable acquisition surface: `acquisitionCaseContracts.ts` defines the
  historical `tester_application_v1` request shape and neutral operator read
  projection. Admission and lifecycle transitions are retired; list and active
  count remain for support. Managed rich tester DTOs stay behind the deployment
  overlay.
- Admin identity reads: `adminSummary.ts` + `adminSummaryClient.ts`,
  `adminClientSearchClient.ts` with the `adminClientsSearch*` contracts in
  `searchContracts.ts`, and the `adminClientsDetail*` contracts in
  `contracts.ts`. Support read helpers use these to find a customer without
  entering the admin UI.
- Shared domain contracts/ports/types: `contracts.ts`, `searchContracts.ts`,
  `ports.ts`, `types.ts`, and `legacyAdapters.ts`.
- Portable operator surface: `portableContracts.ts` defines
  `clients.customer_360.v2`; `portablePorts.ts` is implemented by direct
  Postgres or managed Supabase bindings. Portable callers use `subjectId` and
  neutral lifecycle stages. Optional `managedOverlay` is deployment evidence,
  never a portable dependency.

## Where the code lives
- Shared/frontend: `src/domains/clients/` (contracts, ports, types, admin
  identity clients, `legacyAdapters.ts`)
- Server: `server/domains/clients/` (acquisition case handlers/ports, admin
  client search/detail/summary handlers, agent customer read governance)
- BFF routes: `api/bff/clients/…`, `api/bff/admin/clients/…`

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
