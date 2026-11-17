# Maintainers

`@openlup/core` is maintained in the platform monorepo as part of the coherent
`@openlup/*` package set. The [stability reference](docs/guide/reference/stability.md#public-api)
owns compatibility from 1.0.0 and links the per-subpath classifications.

## Responsibilities

- preserve the `preview` publication settings and the directory-publish
  refusal;
- keep package smoke, license, SBOM, audit, pack, import, and gitleaks proofs
  green;
- keep provider and product-specific behavior outside this package;
- review declaration-snapshot drift against the public compatibility policy
  and each subpath’s classification;
- use the smallest change that preserves the existing export graph and package
  portability proof.

## Local package gate

```sh
npm ci
npm run ci
```

`npm run ci` builds every export, runs tests and coverage, validates declaration
snapshots and documentation, checks licenses/SBOM/audit/pack/publish settings,
and exercises a packed first-party consumer. That consumer is package smoke,
not external-consumer evidence.

## Security

Do not put credentials, customer data, private deployment evidence, or product
policy into this package. Report vulnerabilities through [SECURITY.md](SECURITY.md).
