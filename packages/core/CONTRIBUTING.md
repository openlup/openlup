# Contributing

Commerce Core is public source for framework-independent commerce kernels.
Its npm versions ride on the source previews (`preview` dist-tag only) and
activate no separate package product or stable API.

## Set up and verify

In this package directory, use the Node and npm versions from `package.json`:

```sh
npm ci
npm run ci
```

The gate builds every export, runs standalone tests and isolated package smoke,
verifies declaration snapshots, and checks license, SBOM, audit, pack, and
publish controls. Neither the root test script nor root CI runs it.

## Scope

Keep deterministic rules and provider-neutral contracts here. UI, HTTP routes,
database orchestration, schedulers, credentials, provider SDKs, and
product-specific policy remain outside the package.

Treat exported declarations as internal candidate surfaces. When a declaration
change is intentional, update tests, record the reason in [CHANGELOG.md](CHANGELOG.md),
run `npm run api:update`, and review the snapshot diff. Do not infer a stable
API, SemVer promise, independent release, or external adoption from that proof.

## Security

Never include credentials, customer data, private repository links, or deployment
evidence. For vulnerabilities follow [SECURITY.md](SECURITY.md).
