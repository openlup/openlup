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
- BFF routes: `/api/bff/admin/platform/…`

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.


Admin invite/remove policy lives in the [identity module](../../../docs/platform/IDENTITY.md).
The reference runners call the package use cases directly, pass the reference
message catalogue and select the role-mail locale (`pl`) through the package
inputs, and retain result codes. The notification adapter renders the supplied
locale; reference composition maps delivery receipts. The browser client's parsed
result accepts both response shapes. Direct pending invitations include
`principalId`, `invitationId`, `membershipState: "invited"`, `role`, `invitedAt`,
`expiresAt`, an outcome `code` (`INVITATION_CREATED`, `ALREADY_INVITED` or
`INVITATION_REISSUED`) and an optional `message`. They grant no access until
trusted acceptance. Managed results include `principalId`, `membershipState:
"active"`, `role`, `code` (`MEMBERSHIP_CREATED` or `ALREADY_ACTIVE`) and an
optional `message`, without an invitation ID or deadline. Managed operators appear
in settings immediately; their notification describes active membership, without
pending or deadline copy. Repeated active results send no further notification.
Conflicts expose the package reason as `identityCode` in BFF error details.
Message-only success objects and mismatched state/outcome codes are invalid.
Removal returns `{ revoked: true }` and retains identities and customer links.
Platform settings remain here; the identity owner describes authorization,
directory lookup and direct invitation acceptance, expiry and cancellation.

## Packaged operations

The settings, pipeline-read, alert-view and control-plane compatibility paths now
forward the existing implementation to the experimental operations package.
Schemas/browser clients use `@openlup/platform/operations`; typed ports use
`operations/contracts`; server handlers and watchdog delivery use
`operations/server`. The reference keeps its existing domain evaluator and
explicitly supplies it to the package kernel. Membership schemas and ports,
identity wrappers and tracking effects retain their previous owners and logic.
See the [operations architecture](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics)
for SQL, authorization, replay and preview limits.
