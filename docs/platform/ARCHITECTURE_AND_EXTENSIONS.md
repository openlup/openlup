# Architecture And Extension Boundaries

Status: development-preview contract. This defines the intended public
boundary; it is not evidence that every seam is stable, packaged, or activated.

## Platform and adopter ownership

OpenLup is one platform monorepo containing platform code, official modules, a
reference application, conformance material, and release tools. An adopter is a
separate application. It owns its brand, presentation, catalogue, local market
policy, provider composition, and business-specific integrations.

The reference application demonstrates a neutral platform composition. It is
not a default adopter application and does not transfer ownership of adopter
assets or business policy to the platform.

## Runtime boundaries

Browser-facing modules own portable types, validation, clients, and pure logic.
Server modules own HTTP composition, use cases, authorization decisions, and
persistence ports. Infrastructure modules translate provider protocols and
payloads. Adapters implement ports for a selected provider or runtime.

Dependencies point inward: domain policy depends on ports and contracts, never
on a provider SDK or provider environment shape. Provider-specific payloads and
raw status values end at the adapter boundary. Durable state belongs to the data
contract, not to a browser client or provider response.

`npm run lint` enforces the import side of this in
[eslint.config.js](../../eslint.config.js). A package under `packages/` imports
nothing outside its own directory. Code outside `packages/` reaches a package
only through a subpath its `package.json` `exports` declares, never through a
relative path into `packages/` or an undeclared subpath such as `src` or
`dist`. Domain code under `src/domains` and `server/domains` imports none of
the provider SDKs the config names and no adapter, infrastructure, runtime or
route code; its tests may compose a domain with an adapter. In this repository,
five temporary deprecated re-exports at the old paths of modules that moved out
of the payment domain also cross that boundary: `PaymentForm.tsx`,
`RecoveryPaymentSetupForm.tsx`, `StripePaymentStep.tsx` and
`useStripePromise.ts` in `src/domains/payment/components/`, and
`server/domains/payment/paymentAdapterRegistry.ts`. Each disables the rule only
for the statement that re-exports the moved module and is removed in
`openlup-source-preview/9`: a test fails once the lockstep package version
reaches that preview while any of them remains, and the source preview release
refuses to cut that preview while any still carries its removal marker line.
Provider UI, such as the card payment form, lives with the adapters, while the
words and outcomes it exchanges with its host stay in the domain's contracts.

<!-- openlup-doc-impact {"unit":"browser","digest":"sha256-cd32f2ff96e1fd2b9ddac2e9788fecf3090cc2377b1c5907cbe6ec72fe79e81e","reason":"Presentation-only delta. The account plan facts render the contract's next charge next to the regular package price, and the arrears selector falls back to it before the recurring price. Browser modules still own only portable types, validation and pure presentation; no runtime boundary described here moves."} -->

## Extension seams

Extensions belong at explicit seams:

- provider adapters implement a platform-owned port and capability contract;
- configuration selects an adopter-owned composition without changing domain
  semantics;
- event subscribers react to documented facts without taking hidden ownership of
  the originating transaction;
- themes, copy, catalogue data, and local policy remain adopter-owned inputs;
- an adopter's own domains sit beside the platform's under `src/domains` or
  `server/domains` and are registered as application domains through the
  `#application-domains` import (`src/lib/coreDomains.ts` names the platform's
  core domains; the public binding registers none);
- a new generic capability is proposed upstream with a compatibility owner and
  conformance evidence.

Do not turn a local adapter or a one-business rule into a required platform
dependency. Likewise, do not remove a platform capability merely because one
adopter customizes it: the platform remains responsible for a complete useful
module at its own boundary.

## Source ejection

An adopter can copy a component or page into its own source. This is source
ejection, not an extension point. From that point the adopter owns the copied
surface, including security fixes, tests, compatibility, and manual upgrades.
The platform will not modify or promise compatibility for an ejected copy.

Use a documented extension seam when updates must continue to flow. A source
ejection should be a deliberate, reviewable ownership transfer.

## Compatibility posture

Development-preview seams may change. `P1-SF` is the later gate for stable
extension contracts, a versioned release/BOM, a thin adopter app, conformance
coverage, and upgrade tooling. Until that gate is complete, this document is a
boundary contract for preview work rather than a support promise.
