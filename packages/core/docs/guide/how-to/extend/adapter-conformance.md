# Run an adapter conformance check

Check an email or marketing-sync adapter against offline fixtures before
connecting it to external services. Use `runCommunicationsAdapterConformance`
from the Node-only `@openlup/platform/communications` entry.

## Run the example

Save the complete [offline Node example](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/docs/platform/communications-conformance.mjs)
as `communications-conformance.mjs` in your application root. The application
must have `@openlup/platform` installed with that exported helper. Run:

```sh
node communications-conformance.mjs
```

The example first runs a deliberately broken adapter that reports a failed send
as accepted. It catches `COMMUNICATIONS_CONFORMANCE:email_fixture`, whose message
asks you to match the expected email outcome and provider response and rerun
`runCommunicationsAdapterConformance`. It then runs the corrected adapter and
prints `Corrected offline adapter PASS`.

## Supply your fixtures

Use `CommunicationsAdapterConformanceSubject` to describe an email or
marketing-sync subject. Give it an opaque, non-sensitive `subjectId`. For each
fixture, supply the input, exact expected result and expected external mutation
count. Its `create` factory must return a fresh offline adapter and
`readEffectCount` counter; it receives the fixture input and may asynchronously
seed state before measurement begins.

- Email fixtures must include accepted, failed and suppressed results.
  Suppression must perform no external mutation.
- Marketing-sync fixtures must cover `profile.sync`, `consent.read`,
  `erasure.request` and `erasure.read`, including unavailable operations, and
  include an explicit refusal. Refusals and reads must perform no mutation.
- Each supported marketing mutation needs a successful fixture with
  `replay: true`. Repeating that request must return the same result without
  another mutation. Each supported read needs a completed result.

The runner checks result identity, declared capability and scope independently
of fixture expectations. It also checks negative-feedback mapping and the
evidence required for completed erasure. Declaring an operation unavailable
requires a refusal fixture with its `unsupported` or `verification_pending`
reason.

## Interpret the result

Success returns subject labels, subject kinds and passed case names. Failures
name the violated contract and how to recheck it. Adapter exceptions become
`COMMUNICATIONS_CONFORMANCE:adapter_threw`; inspect the adapter privately for
the underlying exception or malformed result. The runner does not return raw
provider payloads or exception details.

This proves the supplied fixtures only. It does not qualify consent push,
durable-store atomicity, application wiring or a provider account, and it grants
no permission to send messages. Inject offline transports: the helper cannot
sandbox your factory's I/O and does not discover fixtures automatically. The
runner supplies no network client, provider, registry or CLI command; invoke the
helper from your application code.

For payment and fulfillment runners, see
[adapter classes and templates](provider-adapters.md#adapter-classes-and-templates).
