# Choose an extension seam

Use an extension seam to add application behaviour while continuing to consume
OpenLup through its public package exports. Choose the seam by the responsibility
you need to own.

## Extension seams

| Your goal | Seam | How to compose your code |
| --- | --- | --- |
| Connect an external service | Provider adapter | Implement the domain's neutral port, declare capabilities and inject the adapter into the consuming service. Keep protocol translation and service clients inside the adapter. |
| Select infrastructure or application behaviour | Configuration and composition | Supply the documented configuration, policy callbacks and port bindings from your application's composition root. Preserve the domain contract. |
| React to a recorded domain fact | Event subscriber | Bind a handler for the documented event in your application's event registry. Keep the subscriber's work separate from ownership of the originating transaction. |
| Change presentation or commercial inputs | Theme, copy, catalogue and local policy | Keep these inputs in your application and pass them through the relevant configuration or rendering boundary. |
| Add a responsibility unique to your application | Application domain | Keep its browser-safe contracts and server implementation in your own source, then connect its handlers and ports in your composition root. |
| Add a reusable platform capability | Upstream contribution | Propose a generic contract with an explicit compatibility and maintenance owner and conformance evidence. Follow the [contribution rules](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/CONTRIBUTING.md#contribute-existing-adopter-code-then-refactor). |

For an application domain, use your application's own module layout and
registration mechanism. The platform checkout's domain registry and import
aliases are not an installed domain-registration API. Keep your modules beside
your package imports; do not edit a platform domain list to add them.

## Wire and verify the extension

Start with the public port or input contract in your installed package set.
Implement your code in the application, then pass the callable or adapter to the
factory that consumes it. Composition declarations describe selected handlers,
routes and schedules; your host still owns installing and running them.

For example, a fulfillment composition can pass its selected callables,
handlers, schedules and routes to `createFulfillmentContribution` from
`@openlup/platform/composition`. That declaration does not start a worker or
mount a route. An event subscriber can use the `OutboxHandler` contract from
`@openlup/outbox`; bind it in the registry supplied to your outbox worker.

Check success, refusal and replay at the chosen boundary. For provider code,
follow [provider adapters](provider-adapters.md) and
[run an adapter conformance check](adapter-conformance.md).

Keep application-specific rules and dependencies in your application. A local
customization neither makes its adapter a required platform dependency nor
removes the platform's responsibility for its own capability. If the available
seams cannot express the change, record a reproducer and seek an upstream seam.
Read [source ejection](eject-source.md) before copying a component or page.
