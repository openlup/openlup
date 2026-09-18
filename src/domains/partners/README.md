# partners domain

B2B / private-label inquiries and partner pipeline facts.

## Owns / does not own
- **Owns:** B2B/private-label inquiries, partner pipeline facts.
- **Does not own:** D2C client lifecycle (`clients`), tester-program participation.

## Public surface (import cross-domain ONLY these)
- `adminB2BInquiryClient.ts` — admin inquiry list/status client.
- `publicB2BInquiryClient.ts` — public private-label/B2B inquiry submit client
  over `/api/bff/partners/b2b-inquiries`; browser code must not call
  `send-b2b-inquiry` or Supabase Edge URLs directly.
- `contracts.ts` — B2B inquiry list/read compatibility contracts plus the
  provider-neutral `partner_acquisition_v1` case/list/transition contract.
- `ports.ts` — neutral partner acquisition port and legacy status-update port
  shape from `@openlup/core/partners`.

The public acquisition contract intentionally omits `pipedrive_deal_id`, raw
provider evidence and delivery facts. Rich inquiry rows, their managed adapters and the
admin UI remain this deployment's downstream surfaces; the direct PostgreSQL
chain stores only the bounded acquisition projection behind a neutral port.

## Where the code lives
- Engine: `packages/core/src/partners/`, exposed as `@openlup/core/partners` —
  the neutral acquisition port and status vocabulary. `ports.ts` here imports
  those types and adds the legacy inquiry port shape on top.
- Shared/frontend: `src/domains/partners/`
- Server domain: `server/domains/partners/` (provider-neutral orchestration)
- Adapters/runtime: `server/adapters/{postgres,supabase}/`,
  `server/runtime/partners/`
- BFF handlers: `server/bff/partners/…` and `server/bff/admin/partners/…`,
  exposed through `/api/bff/partners/…` and `/api/bff/admin/partners/…`. There
  is no `api/bff/<name>` directory: `api/bff/[...path].ts` is one router that
  dispatches every BFF path.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
