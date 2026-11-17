# Contributing

Commerce Core is public source for framework-independent commerce kernels.
Its npm versions are coherent set versions shared by every `@openlup/*` package
and published on the `latest` dist-tag. Follow the
[stable API contract](docs/guide/reference/stability.md#public-api) and the
[release policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md).

## Set up and verify

In this package directory, use the Node and npm versions from `package.json`:

```sh
npm ci
npm run ci
```

The gate builds every export, runs standalone tests and isolated package smoke,
verifies declaration snapshots, and checks license, SBOM, audit, pack, and
publish controls. Root Vitest excludes this suite. Required `install-proof`
runs the shared API phase and `ci:required` separately from root tests.
`ci:required` uses `release:admission`: the same release checks except the full
live audit, which remains in standalone `ci`, `release:check` and publication.
Repository admission instead refuses newly selected vulnerable production
dependencies against the exact base; inherited advisories do not freeze
unrelated PRs. See [required checks](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#required-and-raw-checks).

## Scope

Keep deterministic rules and provider-neutral contracts here. UI, HTTP routes,
database orchestration, schedulers, credentials, provider SDKs, and
product-specific policy remain outside the package.

Preserve each exported declaration’s declared compatibility commitment. When a declaration
change is intentional, update tests, record the reason in a `changes/<programme>-<slice>.md` fragment in the source
repository (ordinary bullets, optional `###` headings and useful `Migration:`
steps; no `#`/`##`, empty files or conflict markers),
run `npm run api:update`, and review the snapshot diff. Do not infer a supported
installation, independent release, or external adoption from that proof.

## Security

Never include credentials, customer data, private repository links, or deployment
evidence. For vulnerabilities follow [SECURITY.md](SECURITY.md).
