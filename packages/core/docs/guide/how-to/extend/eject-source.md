# Take ownership of a copied component or page

Copy a component or page into your application only when you intend to maintain
that surface yourself. This ownership transfer is called source ejection.

## Check for a seam first

Use a [documented extension seam](choose-an-extension-seam.md#extension-seams)
when configuration, a port, an event subscriber or a presentation input can
express the change. Keeping the platform implementation behind that seam lets
you continue consuming its changes through package upgrades, subject to the
installed contract.

## Record ownership

Before using the copy, make its ownership explicit in your application:

- Record the original component or page and the package or source revision it
  came from, so future changes can be compared.
- Assign responsibility for security fixes, tests and compatibility with the
  rest of your application.
- Plan to inspect upstream changes and port relevant fixes manually during
  upgrades.

The copied surface is application-owned. OpenLup does not update it
automatically or promise compatibility for that copy.

## Keep package engines behind their contracts

The component and page route does not authorize copying an adopted package
engine into your application. Use declared public exports and keep installed
packages unchanged. A wrapper or native adapter is suitable only when it
preserves the installed contract.

If an engine seam is missing or defective, record a local reproducer and hold
the dependent change for authorized upstream work. Keep compatible serving
behaviour or use a compatible rollback that fits the current durable state.
Preserve pending work and published SQL. Unrelated application development can
continue while that dependency is resolved.
