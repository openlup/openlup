# Platform package guidance

Development preview. The artifact is a rail; the identity module is a capability
within it. All entries are experimental. Identity is an unpublished import
candidate; its browser runtime-schema extraction is incomplete.

Compose server factories through the package's declared entries. Supply provider
clients, environment, redirect policy, mail delivery and copy explicitly. Keep
browser code on the declared contracts entry; the server entry is not browser-safe.
Read [the package guide](README.md) and [identity ownership](../../docs/platform/IDENTITY.md).

For example, `createCustomerMeHandler({ mePort, authenticateUser,
responseSchema, responseRequestId })` binds a host's authenticated profile port and observed
request reference to the foundation BFF envelope. The host registers that handler.

Installing this package activates no application policy or external-write
permission. Follow the consuming application's guidance. Report suspected
vulnerabilities through the [repository security policy](../../SECURITY.md).
