# Glossary

Use these definitions when reading the guide.

- **Adapter:** An implementation that binds a port to infrastructure and translates its external data into the port's contract.
- **Application-owned:** Supplied and maintained by your application, including its composition, policies, host bindings and integrations.
- **Cycle:** A scheduled subscription occurrence with its own template and pricing snapshots, payment status and retry state.
- **Development preview:** A release posture that offers no stable framework API, supported full-platform installation or upgrade guarantee.
- **Dunning:** The payment-retry ladder for a failed subscription cycle; exhaustion ends automatic retries without pausing the subscription.
- **Edit window:** The time when an active subscription can be edited, before the cutoff calculated from its next cycle and template's edit-window hours.
- **Maturity:** The classification assigned to an exported package subpath in its release contract.
- **Migration (SQL catalogue):** A SQL unit in an ordered schema history, identified by a manifest that binds its path and bytes.
- **Outbox:** Stored events awaiting dispatch to application handlers; the outbox rail provides transactional enqueue and at-least-once dispatch.
- **Port:** A contract through which application composition supplies an implementation required by an engine or service.
- **Provider:** An external service reached through an application's selected integration.
- **Readiness:** Evaluation of supplied package inventory, contributions, bindings and schema observations for a particular candidate, yielding `ready`, `unsatisfied` or `unknown`.
- **Readiness code:** A machine-readable identifier on a readiness issue, paired with its subject and a suggested fix.
- **Refusal:** A result that declines an operation because its requirements are not met; subscription-engine refusals are returned as values.
- **Refusal code:** A machine-readable reason for a refusal, such as `edit_window_closed` in the subscription engine.
- **Subpath:** A declared package import entry after its package name, such as `@openlup/core/subscription`.
- **Subscription:** The recurring relationship holding a customer's template, lifecycle status, next cycle time and payment-method reference.
- **Upgrade set:** The `@openlup/*` packages used by an application, upgraded together to the same exact version.
