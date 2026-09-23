# Contributing

Commerce Core is public source for framework-independent commerce kernels.
Its npm package remains unpublished (`private: true`); public source previews
do not activate a separate package product or stable API.

## Set up and verify

From the directory containing this package's `package.json`, use the Node and npm versions declared
in this package's `package.json`:

```sh
npm ci
npm run ci
```

The package gate builds every export, runs its standalone tests and isolated
package smoke, verifies
declaration snapshots, and checks license, SBOM, audit, pack, and publish
refusal controls. The repository-root test script does not collect this separate
package suite, and the public root CI workflow does not currently invoke
`npm run ci` from this directory.

## Scope

Keep deterministic rules and provider-neutral contracts here. UI, HTTP routes,
database orchestration, schedulers, credentials, provider SDKs, and
product-specific policy remain outside the package.

Treat exported declarations as internal candidate surfaces. When a declaration
change is intentional, update tests, record the reason in [CHANGELOG.md](CHANGELOG.md),
run `npm run api:update` from this directory, and review the snapshot diff.
Do not infer a stable API, SemVer promise, independent release, or external
adoption from that proof.

## Security

Never include credentials, customer data, private repository links, or deployment
evidence. For vulnerabilities follow [SECURITY.md](SECURITY.md).
