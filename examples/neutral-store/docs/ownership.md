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
