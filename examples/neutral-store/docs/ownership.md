# Application ownership

Status: draft explicit file inventory for extraction and lifecycle consumption.

`ownership.json` is the machine-readable split. Its `owned` and `managed`
arrays contain exact application-relative paths; `sourceMappings` only maps the
archive's non-loading instruction template to the new repository's `AGENTS.md`.
`generated` names local output (a trailing slash denotes a directory), and
`demoData` identifies fictional seed/media files already classified as owned.
`sourceOnly` lists archive tooling and its test, never copied into an application.
No glob, parent checkout discovery or implicit workspace inheritance is needed.
`demoDataNote`, `pageCopyRequiredFor` and `pageCopyRule` preserve the customer
environment boundary and explain which changes require taking ownership of a page.

| Class | Responsibility |
| --- | --- |
| Owned | Identity, configuration, general copy, media, named UI fragments and the application's agent guide |
| Managed | Starter host, pages, shared validation and DTOs, test recipes, lifecycle wrapper and documentation |
| Source only | Extraction script, extraction regression test and instruction template; the source release retains their coverage |
| Generated | Local source provenance, artifact identities, lockfile during candidate preparation and build/browser output |

Managed means eligible for a reviewed starter update, not automatic overwrite.
The package CLI owns its actual upgrade plan/apply semantics. This draft does
not claim that the pending CLI already reads this inventory. The starter's
`./lifecycle ownership` exposes it without mutating files. The wrapper delegates
verify and upgrade to the installed CLI and never adds another upgrader.

In the public source tree, the instructions remain `AGENTS.template.md` so they
do not govern monorepo contributors. Extraction creates the new application's
`AGENTS.md`. Local application rules outside the managed instruction block
must survive subsequent guide updates.

When taking ownership of a page, move its file from `managed` to `owned` and
record why in that application's normal change evidence. Resolve the full
import and security boundary; a copied page receives no automatic platform fix.
Do not move package engines into the application. The installed npm artifacts
are the engine, and their lockfile/integrity and version-matched guidance remain
part of adoption.

During candidate work, the three `.tgz` files and `artifacts/identity.json` are
ignored local inputs. Final release preparation must replace candidate `file:`
pins with one exact published set, remove the candidate lockfile ignore, move
`package-lock.json` from generated to managed and commit the independent app's
registry lockfile. Until then the generated candidate lockfile is ignored and
used for reproducible local `npm ci`, not presented as final release pins.
The source archive, npm publication and an application deployment are different
delivery boundaries; this starter authorizes none of them implicitly.

The extracted repository retains the inventory, but not its `sourceOnly` files.
Its `npm test` runs application tests only. Source-release `npm test` additionally
runs extraction and refusal coverage, including the materialized test command.

`owned/demo-seed.ts` is both owned and demo data. It builds the four catalogue
and price row sets from `StoreConfig`. `installation/install.ts` is managed and
reachable only from lifecycle installation, never the HTTP host; it requires the
install login/current role and a database-level demonstration marker. The
bootstrap runs the complete packaged history in a one-shot container. Only that
container receives the privileged Unix socket; the host receives the runtime
TCP URL only. The missing installed API refuses
`starter_installation_binding_required`, and an existing unmarked database is
never adopted or marked. A customer environment must use its
own data onboarding, never this seed or demonstration marker. Clients, stock and
settings use native writers; renewal terms and method states are purchase truth,
not demo seed inputs.

The optional public origin and insecure-HTTP opt-in are owned configuration and
upgrade inputs. Origin policy, session handling and native composition stay
managed. The private captured mailbox and process sessions are generated local
runtime state, not owned configuration or installed package sources.
The demonstration container's quote-acceptance keyring is also private generated
state under `.context/`, admitted only by the existing database demonstration
marker. The same container reuses it on restart; container recreation discards
it. Customer environments provision their own keyring outside served assets.

The optional `supportEmail` is owned configuration. Managed support rendering
uses text nodes only. Partner/review host composition is managed and reuses the
same request admission and native operator authority as other operator reads.

`owned/catalogue.ts` owns the fictional catalogue-draft type registry. Managed
`host/operator-composition.ts` composes support and catalogue native ports. Native
human membership precedes each operator action; the owner alone provisions and
deactivates the separate support roster as documented in the README. No runtime
roster writer or installer roster seed exists. Drafts and bundle activation do
not replace the owned storefront offer configuration. The managed real-database
browser recipe is `browser/native-operator.proof.ts`.

Acquisition ownership below was established before support and catalogue
composition; its final scope statement describes that earlier contribution only.

`owned/acquisition-addresses.ts` is owned demonstration data beside the catalogue
seed. It contains fictional opaque registry tuples and localized choice labels.
The acquisition foundation migration header, lines 16-17, permits an adopter to load its own
replaceable registry through the database owner connection; the managed installer
uses that contract only after its existing install-identity and demonstration
marker admission. Its insert names every column and verifies provenance/active
state after a keyed conflict. The runtime host only reads the owned list, maps a
choice ID and submits through the native port; it never loads the registry.
Support customer reads and catalogue administration remain unbound. Their
composition is outside this acquisition change.


`host/purchase-composition.ts` composes public native drafts, stock, holds,
compensation, sandbox settlement, renewal attachment and destinations. Its typed
contact-client dependency is injected at this root, never reimplemented as
application INSERTs. Checkout does not import the install-only seed.
`host/checkout-recovery.ts` composes the separate private recovery mailbox;
the host owns and closes the native token transaction lane.
The host names its single role-free lane after its capability, checkout recovery tokens, owns it and closes it.
`client/purchase.ts` owns tab continuation and visible-response redaction. Neither
is an account authority. No demo customer seed or mandatory purchase sign-in exists.

`playwright.database.config.ts` is the managed real-database UI recipe. Its
ignored `.context/database-ui-hosts.json` contains two non-secret loopback UI
origins, never database URLs or capabilities. The proof operator starts those
hosts with installed runtime connections. Browser tracing is disabled because
request bodies carry private capabilities. The required purchase spec remains
byte-identical. Focused regressions live in `test/checkout-recovery.test.ts`.


The one temporary mode-price function is managed in `shared/offer-estimate.ts`.
Its rate/quantum and demonstration purchase values are owned typed configuration;
`owned/demo-seed.ts` uses the same function for distinct per-mode price entries.
The installer compares existing authored price facts and refuses a changed-price
conflict. This changes no native schema and introduces no runtime price writer.
The later installed quote-engine composition removes this temporary function.

Attempt limits live in one process's memory and reset on restart.
Checkout applies the configured attempt window, e-mail and requester counts, retention and capacity before contact resolution. Exact replay means the same command key, normalized e-mail and requester; it is free of further quota counts. A retained key with a changed identity is refused before contact resolution, including with a replacement quota callback. The synchronous host binding keeps identity digests within the same retention and capacity bounds; it fails closed when full. Denied quota attempts add nothing to the quota counts. Both process-local records reset on restart. Unpurchased contact retention belongs to the host.

An admitted new checkout issues a 256-bit recovery token through the native
PostgreSQL port. Only its SHA-256 hash is stored. PostgreSQL fixes expiry at
order creation plus 24 hours; this is a database rule, not a configurable value.
One live link per order: a new link ends the previous link of the same order.
The token is returned only in the creating response and a separate private
captured checkout-recovery message, never an authentication challenge or event.
The completion page reads the URL token once and replaces history synchronously
before configuration fetch or rendering. Request bodies carry the token; memory
and session storage preserve reload convenience but grant no authority. An unchanged repeated submit for the same order keeps its existing token when the replay response omits it. A different order never inherits that token, and a new token replaces the previous one.
Native inspection allows payment only for an active pending order, recognizes
an already-paid order without payment controls, and refuses expired, cancelled
or unavailable links. Indexed hash lookup makes no constant-time claim.
Owning sessions retain order ownership checks. An email alone mints no link for
an existing order. Recovery grants no account or subscription-command access.

Purchase and sign-in share `purchase.inputLimits.email`, capped at 160 characters
by configuration validation. Both demonstrations use 160. Longer purchase e-mails
receive `starter_email_invalid` before contact resolution. Checkout and subscription
address changes share the configured phone and postal-code limits; configuration
cannot exceed the native destination bounds. Browser fields use those same limits.

## Paid-order message ownership

[The paid-mail host](../host/paid-mail.ts) is managed application composition of
the installed commerce handler and public outbox claim/process rail. Its registry
selects only the paid-email event. [The versioned artifact](../host/paid-mail-artifact.ts)
uses the existing atomic private capture protocol; recipients and rendered bodies
remain private generated data. [Owned locale copy](../owned/renewal-copy.ts)
supplies the paid subject and line labels through shared configuration validation.
The lifecycle command runs one bounded pass without starting a scheduler or a
real mail provider. Native subscription notices keep their existing owner.


Shipping fee and free-delivery threshold are owned offer values. The managed
quote binding passes them to the installed shipping policy; it owns no threshold
calculation. The purchase binding retains the accepted shipping agreement for
renewals. There is no separate `renewalShippingMinor` setting: current configuration
cannot override retained terms or a frozen cycle's shipping amount.

`browser/renewal.proof.ts` is a managed, fixture-backed local recipe. Its source
PostgreSQL runner supplies the private mailbox and expected account/order values;
the customer uses only sign-in and account read controls. Fixture files and
Playwright configurations under `.context/` are generated private state.
