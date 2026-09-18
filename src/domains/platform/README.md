# platform domain

Cross-cutting platform boundary: auth, admin users, settings, pipeline
dashboard, observability/watchdog, alert ledger, cron, feature flags, and Axiom
BFF monitor provisioning.

## Owns / does not own
- **Owns:** auth boundary, active/revoked admin membership contracts,
  history-preserving access revocation, settings, pipeline dashboard,
  observability, alert ledger, cron, job catalog, feature flags.
- **Does not own:** product domain rules and provider-specific business logic.
- **Outside this README:** physical trigger/entrypoint inventory, alerting,
  paging, watchdog operations, environment mechanics, and function deployment
  are deployment-specific operational concerns. They are deliberately not
  restated as public platform contracts here.

## Public surface (import cross-domain ONLY these)
- Admin clients/contracts: `adminMeClient.ts`, `adminSettingsClient.ts`,
  `adminPipelineClient.ts`, `adminAlertsClient.ts`, and `contracts.ts`.
  The compatibility admin-user `remove` operation means soft revocation and
  returns `{ revoked: true }`; physical Auth/actor deletion is outside the
  ordinary panel contract.
- Observability: `jobCatalog.ts`, `observabilityContracts.ts`,
  `observabilityEvaluator.ts`, `observabilityPorts.ts`, and
  `paymentObservabilityEvaluator.ts`. OmniPack ops monitors are flag-gated and
  read durable evidence only; provider calls and fulfillment/inventory
  mutations stay outside `platform`.
- Canonical order-money watchdog contracts/evaluation live in
  `orderMoneyReconciliationContracts.ts` and
  `orderMoneyReconciliationEvaluator.ts`; provider-settlement absence is an
  explicit non-pageable diagnostic, never inferred equality.
- `ports.ts` — platform ports.

## Where the code lives
- Shared/frontend: `src/domains/platform/`
- Server: `server/domains/platform/` (admin auth/settings/pipeline handlers,
  watchdog service, alert ledger, observability evidence ports)
- BFF routes: `api/bff/admin/platform/…`

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
