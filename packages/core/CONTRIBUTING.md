# Contributing

Commerce Core is public source for framework-independent commerce kernels.
Below 1.0 its npm versions are set versions `0.N.P`, shared by every
`@openlup/*` package and published on the `latest` dist-tag; versions up to
`0.11.0` rode on the source previews (`preview` dist-tag only). No version
activates a separate package product or stable API.

## Set up and verify

In this package directory, use the Node and npm versions from `package.json`:

```sh
npm ci
npm run ci
```

The gate builds every export, runs standalone tests and isolated package smoke,
verifies declaration snapshots, and checks license, SBOM, audit, pack, and
publish controls. Root Vitest excludes this suite; CI's required test job runs it separately.

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
