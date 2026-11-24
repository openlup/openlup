# Install or scaffold a provider recipe

Install a code-owned, zero-SDK provider adapter into your application's `owned/adapters/<domain>/<provider>` tree, or scaffold a new provider recipe from scratch and verify it offline before wiring credentials.

## When to use a provider recipe

Use a provider recipe when you need to integrate an external payment, fulfillment, shipping, tax, communications, accounting, observability, or sales-channel service without adding third-party vendor SDKs or modifying platform internals.

- **Code-owned:** `openlup recipe add` copies plain TypeScript source files into your application (`owned/adapters/<domain>/<provider>`). You own, audit, and customize the code directly.
- **ADR-001 isolated:** Recipe runtime files import only declared public exports of `@openlup/core`, `@openlup/platform`, and `@openlup/outbox`, Node built-ins (in server runtime modules only), and local relative files. Credentials and `fetchImpl` are injected explicitly at composition time.
- **Offline-verified first:** Every recipe ships with manifest parity checks, static isolation checks, and offline Vitest conformance and mount-proof suites (Stages 1–3).

## Discover and inspect available recipes

List the available recipes or filter by domain, maturity status, or region:

```bash
npx --no -- openlup recipe list
npx --no -- openlup recipe list --domain payments --json
npx --no -- openlup recipe show payments/adyen
```

When running outside an OpenLup monorepo checkout, pass `--catalog <path-to-recipes>` pointing to your local recipe registry checkout. Add `--json` for single-object machine-readable output (`formatVersion: 1`).

## Install and verify a certified recipe

Install a recipe into `owned/adapters/<domain>/<provider>` and run offline Stages 1–3 verification in a single command:

```bash
npx --no -- openlup recipe add payments/adyen --verify
```

`openlup recipe add` refuses to overwrite a non-empty destination unless you pass `--force`, refuses symlinked paths, and writes companion schema/index/provenance metadata outside the recipe directory (`owned/adapters/.openlup-provenance.json`) so the recipe's `files.allFiles` inventory stays exact.

Use a `<container>/<domain>/<provider>` destination layout (the default) when specifying `--dest` so conformance suites that read companion `schema/` files and `index.json` from the parent adapter container resolve cleanly.

## Scaffold a new provider recipe

When no catalog recipe exists for your provider, generate an ADR-001-compliant starter tree and verify it offline immediately:

```bash
npx --no -- openlup recipe scaffold --domain payments --provider acme-pay --verify
```

Supported domains are `payments`, `fulfillment`, `shipping`, `tax`, `communications`, `accounting`, `observability`, and `channels`. Replace the starter transport and adapter methods in the generated server client and adapter modules with the neutral port contract listed in the generated `README.md`, wire the domain conformance runner in the recipe's conformance suite, and rerun verification after each edit.

## Re-verify after local customization

Run offline verification at any time after editing your owned adapter files:

```bash
npx --no -- openlup recipe verify owned/adapters/payments/adyen --json
```

Verification checks four offline stages:

1. **Manifest & disk parity:** `recipe.json` satisfies the recipe schema and `files.allFiles` matches every file on disk.
2. **ADR-001 static isolation:** Runtime files contain no ambient runtime environment reads, no ambient global `fetch()` calls, no disallowed external SDK imports, and no browser-to-server imports.
3. **Platform range compatibility:** Your installed `@openlup/platform` version satisfies `openlupPlatformRange`.
4. **Offline Stages 1–3 suites:** Both declared Vitest suites (`files.conformanceTest` and `files.mountProofTest` in `recipe.json`) pass with zero skipped assertions.

Provenance reports `pristine` when files match the installed hash and `locally-modified` after intentional local edits (local edits do not fail verification).

## Complete live qualification before enabling live traffic

Passing offline Stages 1–3 never certifies live account credentials, webhook secrets, or remote API configuration. Complete the recipe's `LIVE_QUALIFICATION.md` checklist in your own sandbox environment before routing live traffic.

## Related pages

- [Compose a provider adapter](provider-adapters.md)
- [Run an adapter conformance check](adapter-conformance.md)
- [Command line](../../reference/cli.md)
