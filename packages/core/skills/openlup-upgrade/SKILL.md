---
name: openlup-upgrade
description: Plan, execute, and verify an @openlup/* package upgrade using the installed release index, static import impact analysis, capability-aware doctor checks, and characterization tests.
---

# OpenLup Upgrade Protocol

Follow this version-grounded protocol whenever upgrading installed `@openlup/*` packages in an application repository. Read installed files from `node_modules/@openlup/*` before relying on memory.

## 1. Analyze upgrade impact before editing code

Run the offline impact analyzer against your previous pinned version:

```sh
npx --no -- openlup-context impact --from <previous-version> --format markdown
```

(Or invoke the MCP tool `impact_openlup_upgrade` with `{ "from": "<previous-version>" }`, or `npx --no -- openlup upgrade impact --from <previous-version>`.)

Optional flags:
- `--to <version>`: target version (defaults to installed `@openlup/core` release index `currentVersion`).
- `--rail managed|native`: add managed-rail SQL migration guidance or filter rail-specific advisories.
- `--exclude-starter`: hide starter-specific entries if your application composes its own host.
- `--include-dormant`: include new opt-in subpaths outside your currently imported domains.

Review all four buckets in order:
1. **`actionRequiredOnYourImports`**: resolve removed/deprecated symbols, action-required changes, and every `export *` wildcard barrel reported in `wildcardReexports` (wildcard re-exports hide downstream symbol usage from static analysis).
2. **`freeFixesOnYourImports`**: note behavioral fixes landing on subpaths you already import.
3. **`newOptInInYourDomains`**: track opt-in capabilities separately so upgrades stay focused and reviewable.
4. **`sqlAndSettingsDelta`**: inspect every newly shipped SQL migration and setting delta.

## 2. Verify parity and wiring with `doctor`

Move every `@openlup/*` package (`@openlup/core`, `@openlup/outbox`, `@openlup/platform`) together to the same exact version, then run:

```sh
npx --no -- openlup-context doctor --receipt upgrade-receipt.json
```

(Or `npx --no -- openlup doctor --receipt upgrade-receipt.json`.)

Confirm `verdict: "ready"`:
- **`versionParity`**: `package.json`, `package-lock.json`, and `node_modules/@openlup/*` agree on one exact version.
- **`nodeEngine`**: runtime satisfies Node `>=24`.
- **`forbiddenDeepImports`**: zero imports targeting `@openlup/*/src/*` or `@openlup/*/dist/*`.
- **`deprecationsInUse`**: inspect any `@deprecated` symbols reported against installed `.d.ts` files and schedule replacements before the next major release.
- Optional checks (`verify`, `settings`, `recipes`) report `skipped (not_configured)` when your application does not configure them; when `configured`, run the named command explicitly.

## 3. Refresh managed agent rules

Keep the managed OpenLup block in your application's `AGENTS.md` current without modifying private application rules:

```sh
npx --no -- openlup-context agents-sync
```

Pass `--check` in CI to verify the managed block has not drifted.

## 4. Run characterization tests

Before merging or deploying:
- Run your application's typecheck, unit, integration, and contract tests against the upgraded pins.
- Verify real bindings, durable effects, retries, and idempotency; type compatibility alone does not prove runtime behavior.
- Never delete or rewrite application-owned behavior without a passing characterization witness.

## 5. Managed vs. native SQL caveat

- **Never rewrite published SQL.** Apply every newly listed file from `sqlAndSettingsDelta.sqlAdded` through your application's own migration chain in order.
- **Managed database rails:** apply migrations through your managed rail's forward migration workflow, review any `portableAdvisories` reported in `sqlAndSettingsDelta`, and rehearse schema cutover in staging before reopening production traffic.
- **Native PostgreSQL rails:** apply the complete ordered platform migration set and verify schema readiness before starting the updated host.
