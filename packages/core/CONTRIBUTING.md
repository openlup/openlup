# Contributing

Commerce Core is a private portability proof for framework-independent commerce
kernels. It is not a public package or a separately activated product.

## Set up and verify

Use the Node and npm versions declared in `package.json`:

```sh
npm ci
npm run ci
```

The gate builds every export, runs tests and isolated package smoke, verifies
declaration snapshots, and checks license, SBOM, audit, pack, and publish
refusal controls.

## Scope

Keep deterministic rules and provider-neutral contracts here. UI, HTTP routes,
database orchestration, schedulers, credentials, provider SDKs, and
product-specific policy remain outside the package.

Treat exported declarations as internal candidate surfaces. When a declaration
change is intentional, update tests, record the reason in [CHANGELOG.md](CHANGELOG.md),
run `npm run api:update`, and review the snapshot diff. Do not infer a public
API, SemVer promise, independent release, or external adoption from that proof.

## Security

Never include credentials, customer data, private repository links, or deployment
evidence. For vulnerabilities follow [SECURITY.md](SECURITY.md).
