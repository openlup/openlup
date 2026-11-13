# Marketing sync

Synchronize owned profile data and consent with a remote marketing system while
keeping local permission authoritative. Treat provider acceptance, local
recording and observed remote state as separate facts.

## Operations and scope

`MarketingSyncProvider` groups `profile.sync`, `consent.read`, `erasure.request`
and `erasure.read`; `ConsentPushPort` adds `consent.push`. These are neutral
contracts from `@openlup/platform/communications/contracts`. A binding names the
account, environment, namespace and mapping version. An audience is either one
configured audience or explicitly account-wide. Check the operation's declared
capability for that binding and audience: unavailable scope refuses
`unsupported`, and missing admitted account verification refuses
`verification_pending`.

The host maps opaque subject references to owned targets and supplies current
authorization and local evidence. A type assertion or deserialized receipt
does not grant authority. Profile sync writes only owned scalar fields and
properties; it cannot invent permission from a remote subscription or list
membership. Stale subject generation refuses `stale`; an erased subject or
durable erasure tombstone blocks profile writes and consent grants with
`restricted`.

## Consent readback

`consent.read` reports current remote state with `complete`, `partial` or
`unsupported` coverage. Coverage describes that observation, not a complete
history. Preserve the audience on negative feedback: an audience-specific
denial must not become an account-wide denial. Remote `subscribed` state never
grants local consent.

`NegativeFeedback` distinguishes permission from deliverability. Unsubscribe,
complaint and manual block carry `deny_permission`; hard bounce and invalid
address carry `deny_delivery`. Keep each fact's source reference and nullable
occurrence time rather than manufacturing missing provenance.

## Consent push admission and reconciliation

A grant names one subject, local purpose, configured audience and local consent
evidence reference. Withdrawal needs local withdrawal evidence; account-wide
withdrawal requires explicit authority covering every purpose. Missing or blank
evidence refuses `invalid_request`. Foreign, provider-only or substituted
evidence refuses `provenance`; revoked, superseded or wrong-direction local
authority refuses `restricted`.

The declared `grantEffect` says whether a provider grant affects an audience or
the account. Local permission remains audience-scoped even if the remote effect
is broader. Admission must cover that full effect: grants require evidence that
they will not trigger unintended automation or confirmation mail or clear an
existing suppression. Unsafe automation, missing suppression coverage or unsafe
audience removal refuses `restricted`. Historical imports do not bypass these
checks. List membership alone proves neither consent nor safe withdrawal scope.

An unsettled grant must not by itself hold a withdrawal. The withdrawal path
omits the fence caused by unresolved grants, including grant-only account
availability quarantine. It still requires current authority, identity and safe
scope, and respects storage failures, non-grant quarantine, occupied dispatch
slots, pacing and its own replay fence. Account cooling returns
`retryable/cooling` with finite positive `afterSeconds`; the host schedules the
retry. Non-grant quarantine needs explicit host repair. An unresolved withdrawal
blocks new grants for the same subject and overlapping audience.

`accepted` records admitted intent; `acknowledged` records provider acceptance,
including asynchronous acceptance. Neither proves subscribed or unsubscribed
state. Both include `journal` and `reconcileRequired`. A failed local recording
after provider acceptance must remain `journal: "unknown"`.

When an earlier grant remains unsettled, `reconcileRequired` stays true and
remote consent remains `unknown`, even after an early unsubscribed read or a
confirmed journal write. The host must establish settlement of all earlier
grant jobs, then make a fresh authorized `consent.read`. Partial coverage,
pending state or unknown state cannot resolve the race. If that read still says
subscribed, the host reissues withdrawal with a new request ID through its
reconciliation path. The adapter does not automatically retry the write.
`reconcileRequired: false` is also not proof of the remote effect.

## Replay and uncertainty

Replay identity is `(binding, operation, subjectReference, requestId)`, including
every binding coordinate. Generation is a separate stale check, performed
before replay and rechecked across asynchronous work. An eligible request with
the current generation and unchanged effect replays the saved result without
another dispatch. The result echoes the current call; its receipt retains the
original admitted request. Changed audience, action or evidence under the same
key refuses `invalid_request`.

Unresolved dispatch or uncertain persistence can fence new request IDs too.
Treat `unknown/dispatch_unresolved`, `unknown/acceptance_ambiguous` and
`unknown/record_failed` as reconciliation work; a new key is not permission to
repeat the effect. Cooling must survive reconstruction, and a failed cooldown
write closes dispatch until repair.

## Erasure completion

`erasure.request` can admit or acknowledge deletion intent without completing
deletion. Completion requires a fresh authorized `erasure.read` tied to the
original receipt and authenticated provider evidence of deletion. An ordinary
404, empty search, elapsed time or receipt replay cannot prove it. A result type
does not supply a completion implementation: if `erasure.read` refuses
`unsupported`, keep deletion unconfirmed. Erasure
completion must not remove the local tombstone or enable profile recreation.

The separate newsletter bridge also refuses `skipped/unsupported`; selecting
marketing sync does not enable newsletter work. See the
[neutral marketing contracts](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/src/communications/contracts/marketingSync.ts)
for result shapes and [idempotency](idempotency.md#idempotency-contract) for handler retry
boundaries.
