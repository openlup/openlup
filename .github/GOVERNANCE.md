# Governance

## Who decides

OpenLup has a single maintainer, who is also the project's owner and the author
of the code it was extracted from. That person decides scope, architecture,
roadmap, and what is merged.

This is stated plainly rather than dressed up as a committee. A one-person
project with an honest governance file is easier to rely on than one with a
governance structure that does not exist in practice, because you can see exactly
how much bus factor you are taking on.

The structure will grow when there is something to grow: sustained contributors
first, then commit rights, then shared decision-making. It will not be invented
in advance of the people.

## How decisions are recorded

Decisions that change the shape of the project are written down in the repository
before they are implemented, together with what would have to be true for them to
be wrong. A decision that exists only in a maintainer's head is not a decision
anyone else can build on.

## Contributions

Contributions are accepted by pull request under the Developer Certificate of
Origin. The DCO text, the sign-off line, and how to add it are in
`CONTRIBUTING.md`; that file is the single source and this one does not restate
it.

**There is no CLA, and there will not be one.** You keep the copyright in your
contribution. The project does not ask you to assign rights or to grant it the
ability to relicense your work.

The reason a CLA is unnecessary is mechanical rather than a matter of goodwill.
Section 5 of Apache-2.0 provides that a contribution intentionally submitted for
inclusion in the work is submitted under the terms of that same licence, unless
you explicitly state otherwise. Inbound equals outbound by default, so the grant
a CLA would exist to establish is already established by the licence everything
here is published under. Asking you to sign a second agreement for it would add
paperwork without adding rights.

AI-assisted contributions are welcome under `.github/AI_CONTRIBUTION_POLICY.md`:
disclosure and human accountability, never a ban.

## How work becomes official

The project defines core as the useful 80/20 platform and expects adopters to
build their business specifics behind public extension seams once the stable
channel exists. They may keep that work private or offer it back; Apache-2.0
permits both. Acceptance of code is not, by itself, a promise that OpenLup will
support it forever.

Every capability has one admission state, and promotion is explicit:

```text
private -> community -> official-experimental -> official-stable -> core
```

| State | Owner and promise |
| --- | --- |
| `private` | The adopter owns it. OpenLup has no listing, review, release, or support obligation. |
| `community` | Its contributor owns it. OpenLup may list it for discovery, but listing is not endorsement, security review, compatibility, or support. |
| `official-experimental` | A named OpenLup maintainer owns it. It may ship in preview artifacts and can break only with explicit upgrade notes. |
| `official-stable` | A named OpenLup maintainer owns its public contract. It ships through the stable platform release/BOM and follows stable deprecation and support rules. |
| `core` | It is official-stable and necessary to keep the 80/20 subscription-commerce platform useful without adopter reimplementation. |

Promotion requires all of the following: usefulness across the target adopter
class rather than one customer, tests and documentation, a named maintainer with
real capacity, and an owner for the complete public compatibility surface.
Popularity, download count, one adopter's request, or an accepted pull request is
not enough. Maintainer capacity is a product constraint: declining or deferring
promotion is more honest than granting an official label nobody can sustain.

The fact that an adopter *could* build something themselves is never, by itself,
a reason to leave an 80/20 capability out of core. Conversely, source ejection
or a copied starter surface transfers ownership to the adopter: after ejection,
OpenLup does not silently promise to merge or upgrade those adopter-owned bytes.
Changing an official-stable or core classification requires a recorded decision,
an available replacement where the 80/20 promise still requires the capability,
and the stable compatibility bridge in `VERSIONING_AND_EOL.md`.

### Community listing and ownership loss

No public community catalogue, submission schema or listing intake exists in
the current quiet-preview phase. The rules below define future eligibility;
they are not an invitation to submit a listing today and no roadmap may claim a
community marketplace until those three mechanisms exist.

A community listing must name a canonical source repository and release,
licence, current owner, compatibility claim and private security-reporting
route. OpenLup does not copy or release those bytes. A listing may be refused or
removed for spam, misrepresentation, abandonment, unresolved security risk,
missing ownership metadata or incompatibility; delisting is discovery hygiene,
not a licence revocation or judgement on downstream use. Disputes are decided
by the maintainer and recorded when they change a reusable rule.

Maintainer capacity is rechecked for every stable platform release and whenever
an official module loses its named owner. An orphaned official-experimental
module is frozen or returned to community status with explicit preview notes.
An official-stable or core module cannot be silently demoted: it is marked
orphaned/deprecated, receives either a new capable owner or a replacement, and
leaves a future BOM only through the versioning/deprecation bridge. If it is
still required by the 80/20 promise, the project must replace its ownership or
implementation rather than simply dropping the capability.

## Naming conventions in this repository

The platform is `OpenLup`. Where documentation, fixtures, or sample data need a
merchant, that merchant is **"Example Store"** - a neutral placeholder, never the
platform's own identity, and never a real business. Any adapter or sample naming
a specific vendor is a reference implementation, not a dependency of the core.

**The name set is settled, and the publication is not.** The project name is
decided, and every identifier in the source now agrees with it: the repository
manifest, the kernel package, the UI package, and the configuration assistant
all read `openlup`. The npm scope was claimed by the owner on 2026-08-24; what
is still open is publication - nothing is released under it - so **do not depend
on a package name, branch, commit, or source checkout yet**. A supported adopter
dependency begins only when a tagged stable release states its platform BOM and
artifacts. The remaining open items are technical steps, not naming decisions.

## Release posture

The project is in a deliberately quiet phase. There is no launch event, no
announcement channel, no newsletter, and no community-management machinery. This
is a choice about pace, not neglect, and it can be reversed later - the reverse
is not possible, which is why this order was chosen.

The files alongside this one are binding public policy even before automation
enforces every boundary. They do not turn a development preview into stable;
they define which evidence a future stable release must carry so support,
security, versioning, and licensing are not improvised under load.

## If the project stops

The sole cessation trigger, support-window mechanics and archival procedure are
owned by `.github/VERSIONING_AND_EOL.md`. This governance file consumes that
contract; it does not define a second procedure. In particular, inactivity does
not silently erase an already published stable support promise.

This commitment is here because the alternative is a well-known failure: a
project that has stopped, with living documentation, an unarchived repository,
and no notice - so that readers keep arriving and investing in something nobody
is maintaining. Leaving the flag unset is itself a form of misleading people.
The exceptional-cessation record is an honest end to support, not a pretence
that a bus-factor-one project can guarantee maintenance after it has ceased to
exist. An archived repository stays forkable, and Apache-2.0 guarantees that
the code you already have keeps working under the terms you got it under.
