# Wave 3 Specification: Standalone `openlup/recipes` Split & Mass Recipe Factory

Status: ready for execution upon explicit authorization after `@openlup/platform@1.4.0` is published on npm.  
Governing documents: [Provider Recipes Master Plan](../PROVIDER_RECIPES_MASTER_PLAN.md) (§4.1, §8, §9, §10) and [ADR-001](../adr/ADR-001-provider-recipes-architecture.md).  
Prepared: 2026-11-24.

---

## 1. Objective & Scope

Execute the mechanical extraction of `recipes/` from `openlup/openlup` into a standalone public repository `openlup/recipes`, establish the six-pillar bidirectional consistency architecture (§4.1), upgrade `openlup recipe` CLI to support version-checked remote registry discovery (`index.json` + `compatibility-matrix.json`), and open the high-throughput Tier B agent & community PR pipeline capable of scaling safely from 15 recipes to 100s–1,000s without adding CI or merge-queue contention to `openlup/openlup`.

### Explicit Non-Goals (Out of Scope for Wave 3 Split)
- No breaking changes to `@openlup/core`, `@openlup/platform`, or `@openlup/outbox` 1.x public SemVer contracts.
- No live provider credentials or live network calls in CI (all Stages 1–3 remain 100% offline; Stage 4 remains explicit adopter responsibility via `LIVE_QUALIFICATION.md`).
- No npm publication of individual recipes as closed runtime packages (recipes remain plain, code-owned TypeScript source copied into `owned/adapters/<domain>/<provider>`).

---

## 2. Pre-Execution Entry Gate (Exit Criteria from Monorepo Incubation)

All three §4.1 exit criteria MUST be green before running `git subtree split`:

| # | Exit Criterion | Current Status (2026-11-24) | Evidence |
| --- | --- | --- | --- |
| 1 | At least one certified `exemplar` recipe per active Wave 1/2 domain (`payments`, `fulfillment`, `shipping`, `tax`, `accounting`, `observability`, `channels`) | **MET** | 15 certified recipes across 8 domains on `openlup/openlup` `main` (163/163 Stages 1–3 tests passing via `openlup recipe add --verify`). |
| 2 | Deterministic `recipes/index.json` generation from per-recipe `recipe.json` manifests | **MET** | `recipes/scripts/generate-index.ts` (#1023) with full unit/negative-control test coverage. |
| 3 | `@openlup/platform@1.4.0` published on npm (exposing `./adapter-kit`, `./shipping/testing`, `./communications/testing`, `./accounting*`, `./observability*`, `./channels/testing`, and `openlup recipe`) | **PENDING RELEASE AUTHORIZATION** | Currently `1.3.0` on `main`; requires explicit release authorization before split execution. |

---

## 3. Target Repository Layout (`openlup/recipes`)

```text
openlup/recipes/
  .github/
    workflows/
      pr-recipe-verify.yml          # Path-filtered <60s CI (Stages 1-3 + 5 anti-slop gates)
      post-merge-index.yml          # Deterministic index.json rebuild on main (zero PR contention)
      rc-exemplar-canary.yml        # Triggered via repository_dispatch from openlup/openlup RC
      nightly-compat-matrix.yml     # Sharded verification vs latest, next, supported 1.x
      upstream-drift-watch.yml      # Scheduled read-only API/webhook changelog watcher
    CODEOWNERS
    pull_request_template.md
  package.json                      # Cold-consumer npm deps ONLY (@openlup/core, @openlup/platform, @openlup/outbox, @openlup/recipe-guardrails)
  package-lock.json
  tsconfig.json                     # Strict TypeScript checking against installed npm @openlup/* types
  vitest.config.ts
  index.json                        # Generated post-merge ONLY (never hand-edited in recipe PRs)
  compatibility-matrix.json         # Generated nightly (and on RC canary); machine-readable per-version status
  README.md
  CONTRIBUTING.md
  schema/                           # Consumed from pinned @openlup/recipe-guardrails (symlink-free copy checked in CI)
  scripts/
    generate-index.ts
    build-compat-matrix.ts
    verify-changed-recipes.ts
  recipes/
    payments/<provider>/...
    fulfillment/<provider>/...
    shipping/<provider>/...
    tax/<provider>/...
    communications/<provider>/...
    accounting/<provider>/...
    observability/<provider>/...
    channels/<provider>/...
    regional/<pack>/...             # Track C graduated regional packs
```

### Zero-Contention PR Invariant
- A recipe contribution PR in `openlup/recipes` MUST touch **only** `recipes/<domain>/<provider>/**`.
- CI rejects any recipe PR that modifies `index.json`, `compatibility-matrix.json`, or another provider's directory.
- `post-merge-index.yml` runs on `push` to `main` (concurrency group `index-main`, cancel-in-progress: `false`), executes `generate-index.ts`, and commits `index.json` via a signed bot commit.

---

## 4. Six-Pillar Cross-Repo Consistency Architecture (Concrete Contracts)

### Pillar 1 — Cold-Consumer npm Spine
- `openlup/recipes/package.json` depends on exact pinned npm versions (`"@openlup/platform": "1.4.0"`, `"@openlup/core": "1.4.0"`, `"@openlup/outbox": "1.4.0"`).
- No `file:../openlup` workspace references are permitted in `main`.
- Every PR check proves that every recipe compiles and passes Stages 1–3 against **published** npm artifacts.

### Pillar 2 — Pre-Release RC Canary Gate (`openlup/openlup` → `openlup/recipes`)
- **Dispatch payload** emitted by `openlup/openlup` release workflow before promoting a `1.x` RC to `latest`:
  ```json
  {
    "event_type": "openlup_platform_rc",
    "client_payload": {
      "platformVersion": "1.5.0-rc.1",
      "distTag": "next",
      "sourceSha": "<40-char git sha>",
      "runId": "<github actions run id>"
    }
  }
  ```
- `rc-exemplar-canary.yml` installs `@openlup/core@<v>`, `@openlup/platform@<v>`, `@openlup/outbox@<v>` in a clean runner and runs `openlup recipe verify` against **all `status: "exemplar"` recipes** (one per domain).
- **Blocking rule:** Any failure on an `exemplar` recipe reports a failed commit status/check back to `openlup/openlup` and blocks `latest` promotion. Failures on non-exemplar (`verified` / `experimental`) recipes emit an advisory report only and never block core releases.

### Pillar 3 — Nightly Compatibility Matrix (`compatibility-matrix.json`)
- Schema (`schemaVersion: 1`):
  ```json
  {
    "schemaVersion": 1,
    "generatedAt": "2026-12-01T03:00:00.000Z",
    "matrixVersions": ["1.4.0", "1.4.1", "1.5.0-next.0"],
    "recipes": {
      "payments/adyen": {
        "recipeTreeSha256": "<64-hex>",
        "openlupPlatformRange": "^1.3.0",
        "results": {
          "1.4.0": { "status": "verified", "testsPassed": 8, "testsTotal": 8, "verifiedAt": "2026-12-01T03:00:00.000Z" },
          "1.5.0-next.0": { "status": "verified", "testsPassed": 8, "testsTotal": 8, "verifiedAt": "2026-12-01T03:00:00.000Z" }
        }
      }
    }
  }
  ```
- Any recipe failing offline Stages 1–3 against a tested `@openlup/platform` version is automatically marked `status: "unverified-for-<version>"` with its failing stage code (`manifest`, `staticIsolation`, `platformCompatibility`, or `stages1to3Tests`).

### Pillar 4 — Versioned Guardrails & Schemas Distribution
- Package `recipes/schema/{recipe,csp}.schema.json` + the recipe `ast-grep` rule pack (`recipes-no-ambient-fetch`, `recipes-no-ambient-fetch-tsx`, `domain-no-environment-reads`) + recipe ESLint flat-config snippet into a lightweight versioned package or subpath exported from `openlup/openlup` (target: `@openlup/recipe-guardrails` or `@openlup/platform/recipe-guardrails` — evaluate pack-cap impact before choosing; prefer separate zero-dep `@openlup/recipe-guardrails` package so `@openlup/platform` pack caps remain untouched!).
- `openlup/recipes` pins that package in `devDependencies`, guaranteeing zero copy-paste drift when new security rules are added in core.

### Pillar 5 — Remote Registry Protocol for `openlup recipe` CLI
Extend `packages/platform/src/lifecycle/recipeCli.mjs` (preserving 100% offline/local `--catalog <dir>` backward compatibility):
1. **Explicit opt-in remote registry flag:** `--registry <https-url>` (never contacts the network implicitly without explicit opt-in or configured pinned registry URL; enforces `https://` pinned origin + SHA-256 verification of downloaded manifest and every file in `files.allFiles` against `index.json` / `compatibility-matrix.json`!).
2. **Compatibility-aware filtering & refusal:** When `compatibility-matrix.json` is present alongside `index.json`, `openlup recipe list` and `openlup recipe show` display compatibility for the workspace's **installed** `@openlup/platform` version, and `openlup recipe add` refuses installing an `unverified-for-<installedVersion>` recipe unless `--allow-unverified` is explicitly passed.
3. **Integrity pinning:** Every remote-fetched file MUST match its declared `sha256` in the signed/pinned registry manifest before any byte is written to `owned/adapters/<domain>/<provider>`.

### Pillar 6 — Automated Upstream Provider API Drift Maintenance Loop
- `upstream-drift-watch.yml` runs weekly inside `openlup/recipes` (never touches `openlup/openlup`).
- Inspects pinned provider API version metadata declared per recipe, flags deprecated API versions / webhook header changes via GitHub Issues labeled `provider-drift`, and optionally dispatches Tier B worker PRs subject to the identical 5 anti-slop gates and cold Tier A review.

---

## 5. Mechanical Split Runbook (`openlup/openlup` → `openlup/recipes`)

Execute ONLY after `@openlup/platform@1.4.0` is live on npm and explicit user authorization is granted:

1. **Snapshot & Extract History:**
   ```bash
   git fetch origin main
   git subtree split --prefix=recipes -b recipes-split-v1 origin/main
   ```
2. **Bootstrap `openlup/recipes`:**
   - Create public repo `openlup/recipes` with branch protection (`main`, required `pr-recipe-verify`, DCO, linear history).
   - Push `recipes-split-v1:main` and apply the Wave 3 scaffold commit (`package.json` pinned to `@openlup/*@1.4.0`, CI workflows, `tsconfig.json`, `vitest.config.ts`).
   - Run full cold-consumer verification across all 15 recipes (`npx vitest run` + `tsc --noEmit` + `ast-grep` + `eslint` + `generate-index.ts --check`).
3. **Wire Bidirectional CI:**
   - Configure scoped fine-grained dispatch token in `openlup/openlup` for `rc-exemplar-canary.yml` and dry-run one `repository_dispatch` event against `@openlup/platform@1.4.0`.
   - Enable `nightly-compat-matrix.yml` and verify first generated `compatibility-matrix.json` artifact.
4. **Retire Monorepo Incubator (`openlup/openlup` cleanup PR):**
   - Replace `recipes/` content in `openlup/openlup` with a concise pointer `recipes/README.md` (or remove `recipes/` and update `config/openlup-publication-catalog.json` + `vitest.config.ts` + `recipeCli.test.ts` fixtures to use a tiny self-contained synthetic test catalog fixture so `openlup/openlup` tests never depend on external recipes!).
   - Verify `npm run preflight`, `npm run lint`, `npm run packages:check`, and `npm run oss:published-tree -- --self-check` pass with 0 findings.

---

## 6. Track C Regional Pack Graduation (Post-Split)

Once `openlup/recipes` is live and green:
- Migrate regional/legacy reference adapters currently in `server/adapters/` (regional carrier SOAP/REST stacks, parcel locker pickup integrations, regional fiscal/invoicing connectors, and national business registry lookup clients) into `openlup/recipes/recipes/regional/<pack>/` as standalone, ADR-001-isolated Tier 3 recipes backed by their respective Tier 1 ports and conformance runners.
- Keep `openlup/openlup` focused strictly on neutral Tier 1 contracts, conformance kits, and minimal Tier 2 synthetic/reference witnesses.

---

## 7. Verification & Acceptance Criteria

Wave 3 is complete when ALL of the following are verified with recorded evidence:
1. `openlup/recipes` runs cold-consumer CI against published `@openlup/platform@1.4.0` with **15/15 recipes green** and path-filtered single-recipe PR CI completing in **< 60 seconds**.
2. Zero-contention proof: 3 concurrent recipe PRs merge cleanly with zero conflicts on `index.json`.
3. `rc-exemplar-canary.yml` successfully blocks a synthetic breaking change on an exemplar and passes on a clean RC dry-run.
4. `nightly-compat-matrix.yml` emits a schema-valid `compatibility-matrix.json` consumed cleanly by `openlup recipe list --json` and `openlup recipe add --verify --json`.
5. `openlup/openlup` passes full CI after retiring the monorepo incubator with zero regression to `openlup recipe` CLI tests (backed by minimal synthetic fixtures) and zero pack-cap increases.

---

## 8. Rollback Plan

Because the split uses `git subtree split` and the monorepo incubator is only retired in Step 4 (after Steps 1–3 are 100% verified), rollback at Steps 1–3 has **zero impact** on `openlup/openlup` (archive or fix `openlup/recipes` before Step 4). After Step 4, the exact pre-retirement commit in `openlup/openlup` remains cleanly revertible via a single `git revert`.
