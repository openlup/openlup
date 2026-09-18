# Marketing Domain

Status: active

`marketing` owns campaign and acquisition modules that help the business learn,
target, and convert demand before or around commerce flows. New marketing
surfaces must live under one of its subdomains instead of creating a sibling
top-level domain.

## Subdomains

- `marketing/prelaunch` - read-only lead orchestration over waitlist,
  tester-program participation, product-test feedback history, launch-invite
  targeting, and conversion-readiness read models.
- `marketing/research` - survey/research response contracts, admin read models,
  and public survey submit orchestration.
- `marketing/tools` - lead-generation utilities such as the pet personalizer,
  quizzes, calculators, and future acquisition tools. ⚠️ Withheld by the
  deployment overlay: neither `src/domains/marketing/tools/` nor
  `server/domains/marketing/tools/` is part of the published tree, so a
  published tree carries no tool contracts, ports, or generation handler.

## Boundaries

Marketing may reference lead intent, source attribution, campaign context,
research answers, and conversion-readiness summaries. It does not own canonical
customer identity, pet identity, consent authority, email delivery, tester
lifecycle mutations, feedback persistence, fulfillment, payments, or commerce
order reviews.

Canonical contact and pet facts stay in `clients` or future customer-owned
commerce domains. Marketing records are leads until an explicit conversion flow
creates or links a customer.

## Where the code lives

- Engine: `packages/core/src/marketing/research/`, imported through the
  `@openlup/core/marketing/research` package export - survey type, admin
  response, and public submit contracts plus the structural read/submit ports.
  The `marketing/research` modules in this tree are compatibility shims over
  that export, so a behaviour change belongs in the package, not in a shim.
- Shared/frontend: `src/domains/marketing/prelaunch/` and
  `src/domains/marketing/research/`.
- Server: `server/domains/marketing/prelaunch/` (lead read model and admin
  handler) and `server/domains/marketing/research/` (survey submit, admin
  responses, acquisition evidence ports).
- BFF source: physical handler files live in `server/bff/marketing/…`; their
  logical coordinates in the full source dispatcher are
  `/api/bff/marketing/…`.

The bounded public-reference materialization deliberately projects the BFF
router to an empty route table and its capability manifest refuses API/BFF and
mutation capabilities. Therefore, source files and logical coordinates do not
assert that a marketing route is mounted in that reference runtime or deployed
anywhere. An adopter owns any runtime composition and deployment selection.
For public platform/adopter ownership and the published inventory, use the
[architecture and extension boundary](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
and [publication catalog](../../../config/openlup-publication-catalog.json).

The waitlist and tester-program participation this domain reads about belong to
an acquisition programme that is ended and whose code is being retired; a
published tree carries the lead, survey, and conversion-readiness side of the
boundary, not tester admission or tester lifecycle actions.
