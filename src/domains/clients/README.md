# clients domain

The reference application's contact and lifecycle domain. Its current adapters use
legacy tester/waitlist persistence and the physical `clients`/`pets`/`addresses`
tables. Those tables, including the pets schema, describe this reference data
model; adopters are not required to reproduce it. The portable
`clients.customer_360.v2` contract uses a neutral subject ID and lifecycle stage.

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
- Acquisition history: `acquisitionCaseContracts.ts` forwards case projections,
  address references, list/count reads and idempotency keys from
  `@openlup/platform/marketing`, preserving schema identity. The application keeps
  retired submit/transition contracts and its client-version binding, built over
  the package primitives; those admission contracts are not published. Server
  readers use `@openlup/platform/marketing/server` without loading `pg`;
  PostgreSQL factories use the separate `/marketing/server/postgres` entry.
  The server entry's structural compatibility commands retain the retired adapter signatures. The pre-extraction parse transcript and unchanged
  contract suite pin outputs, defaults and complete ordered validation issues.
  The package case port exposes only list/get/activeCount/close; the server-only
  port extends it with historical submit/transition commands and methods. A compiler
  witness checks assignability both ways against the original complete shape.
  The client-search engine and its version remain application-owned.
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
- BFF routes: `/api/bff/clients/…`, `/api/bff/admin/clients/…`

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
