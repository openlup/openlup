# Server Execution Adapters

Status: source-of-truth

`server/adapters` contains execution adapters that implement provider-neutral
domain ports. Adapters translate domain intent into a provider operation or
simulator/noop operation while keeping domain services provider-agnostic.

Provider names in this directory are current implementation choices. New docs
and interfaces should describe the reusable capability first, then name the
current adapter only as an implementation detail. The neutral surface map lives
in [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md).

## Owns

- Provider-specific execution decisions for a named local port.
- Simulator/noop implementations used by hidden preview and local tests.
- Mapping from provider responses back to domain-neutral result objects.

## Does Not Own

- Provider HTTP clients, env parsing, signatures, and low-level payload
  verifiers: `server/infra/*`.
- Domain state machines or persistence decisions: `server/domains/*`.
- Route auth/rate-limit/session composition: `server/bff/*` and `api/cron/*`.

## Rules

- Adapters must be injectable and testable without live provider credentials.
- Provider errors must be sanitized before leaving the adapter boundary.
- Live mutations require an adopter-owned explicit gate and release evidence.
  This source directory does not select a provider or activate a capability;
  [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
  owns the public seam.
- The transactional send port and the admin role notification adapter
  read the selected `#email-presentation` import from the root `package.json`.
  The public map selects the neutral example; an adopter can select its own
  presentation in its application manifest without changing these adapters.

## Capability Map

| Capability | Current adapters | Owns | First docs |
| --- | --- | --- | --- |
| Payment execution and reconciliation | `stripe/`, `tpay/`, `noop_payment/` | Provider execution, webhook normalization, sandbox/noop behavior, and payment-provider evidence mapped back to payment-control contracts. | `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, `../../src/domains/payment/README.md` |
| Fulfillment execution | `dhl/`, `omnipack/`, `noop_shipping/` | Carrier/3PL execution, simulator behavior, and fulfillment-provider evidence mapped back to fulfillment contracts. | `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, `../../src/domains/fulfillment/README.md` |
| Accounting document execution | `fakturownia/`, `accounting/` | Provider invoice/PDF/email/KSeF execution or preview test-provider behavior after accounting policy approval. | `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, `../../docs/platform/DATA_AND_MIGRATIONS.md` |
| Company identity lookup | `mfVat/`, `gusCeidg/`, `ceidg/` | Country/provider-specific lookup enrichment behind the company-identity contract. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../src/domains/company-identity/README.md` |
| Communications delivery and sync | `resend/`, `noop_newsletter/` | Email/newsletter provider execution, ledgers, delivery timeline, and provider-neutral sync evidence. | `../../docs/platform/CANONICAL_CONTRACTS.md`, `../../src/domains/communications/README.md` |
| Storage/blob | `@openlup/platform/blob`, bound by `server/adapters/supabase/blobStorage.ts` and `server/adapters/vercel/blobStorage.ts` | Blob storage port implementations for hosted and self-host profiles; the reference bindings pass the environment and keep their former import paths. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md` |
| Data gateway and migrations | `@openlup/platform/data` and `/migrations`, bound by `supabase/` and `postgres/` | DataGatewayPort and migration-runner implementations for managed backend and direct-Postgres bundles. The bindings supply the Supabase client factory, the process environment, this application's migration catalogue and lock name, and the named role-free lanes. | `../../docs/platform/DATA_AND_MIGRATIONS.md`, `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md` |
| Catalog reads | `supabase/`, `postgres/` | Row-assembled catalog read ports. Both select `primary_sku_id` and the two SKU sellability columns in every projection and leave variant order and primary SKU resolution to the catalog assembler, so no read depends on the order rows arrive in. | `../../src/domains/catalog/README.md` |
| Scheduler/runtime | `@openlup/platform/http`, `/scheduler` and `/job-ledger`, bound by `server/adapters/node/httpRequestAdapter.ts`, `server/adapters/scheduler/jobRegistry.ts`, `server/adapters/postgres/platformJobRunLedger.ts` and `server/adapters/supabase/platformJobRunLedger.ts` | Scheduled job registration/execution and platform runtime seams. The job registry binding names `config/platform-runtime.json` as its default source. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md` |
| Auth and identity | `supabase/` | Admin/customer identity verification, account linking, admin-user action ports, and test identity seams. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../docs/platform/CANONICAL_CONTRACTS.md` |
| Simulators/noops | `noop_payment/`, `noop_shipping/`, `noop_newsletter/`, `accounting/` test provider | Deterministic local/preview behavior that proves domain contracts without live provider side effects. | Owning domain README and [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md); adopter configuration is separate deployment evidence. |

## Public navigation and availability

Use [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.

The managed observability event reader projects only `subscription_id` and
`event_type`, filtered on `occurred_at` within the preceding 24 hours and capped
at 2,000 rows. It needs SELECT on those three columns, not event payload access
or direct INSERT. The unbound winback adapter does not establish a runtime
writer requirement. Tests retain the window's old-versus-recent reminder signal.

<!-- openlup-doc-impact {"unit":"adapters","digest":"sha256-3bba11de7845c19f9b4616e3c9c6245e2b908061b541e1598b33e4eb23599921","reason":"Type-name delta only. The scheduler adapter's job registry now imports the package's renamed declaration type ScheduledJobDeclaration and re-exports it under its previous name ScheduledJob, so the adapter's exports, the registry it loads and every adapter row described here are unchanged."} -->
