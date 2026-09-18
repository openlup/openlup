# Maintainers

`@openlup/core` is maintained as a private portability proof. It is not an
independent product or release channel before the phase-5 platform activation.

## Responsibilities

- preserve `private: true`, blocked-registry configuration, and the
  fail-closed publish lifecycle;
- keep package smoke, license, SBOM, audit, pack, import, and gitleaks proofs
  green;
- keep provider and product-specific behavior outside this package;
- review declaration-snapshot drift as an internal candidate contract change,
  without implying public stability or SemVer;
- use the smallest change that preserves the existing export graph and package
  portability proof.

## Local package gate

```sh
npm ci
npm run ci
```

`npm run ci` builds every export, runs tests and coverage, validates declaration
snapshots and documentation, checks licenses/SBOM/audit/pack/publish refusal,
and exercises a packed first-party consumer. That consumer is package smoke,
not external-consumer evidence.

## Security

Do not put credentials, customer data, private deployment evidence, or product
policy into this package. Report vulnerabilities through [SECURITY.md](SECURITY.md).
