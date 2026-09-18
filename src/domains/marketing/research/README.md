# Marketing Research Subdomain

Status: active

`marketing/research` owns survey and research response contracts for acquisition
learning. It covers kiosk/public survey submission orchestration and admin read
models for survey responses.

Research captures answers and source context; it does not own customer identity,
client records, email delivery policy, or commerce feedback after purchase.
Public submissions must go through `/api/bff/marketing/research/*`; browser code
must not call Supabase Edge Functions directly.

Public surface:

- `contracts.ts` - compatibility shim to
  `@openlup/core/marketing/research` for survey type, admin response, and
  public submit contracts.
- `ports.ts` - compatibility shim to
  `@openlup/core/marketing/research` for admin read and public submit
  ports.
- `adminSurveyResponsesClient.ts` - admin BFF client for survey responses.

## Where the code lives

- Engine: `packages/core/src/marketing/research/`, imported through the
  `@openlup/core/marketing/research` package export - the contracts and ports
  named above. A behaviour change belongs there, not in the local shims.
- Shared/frontend: `src/domains/marketing/research/` (shims plus the admin
  client).
- Server: `server/domains/marketing/research/` (public survey submit handler,
  managed submit path, admin responses handler, acquisition evidence ports).
- BFF handler files: `server/bff/marketing/research/…`, exposed through
  `/api/bff/marketing/research/…`.

The core package owns only research response JSON, current read/submit wire
contracts, and structural ports. BFF route paths, admin clients, Supabase table
mapping, notification email config, and provider/env
wiring stay downstream in openlup. The current wire shape is compatibility-first;
before public npm launch, revisit whether `producer`/`consumer`, snake_case read
rows, and email-skip compatibility belong in the final public API.
