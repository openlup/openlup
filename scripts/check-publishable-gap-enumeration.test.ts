// The public README must point at machine-owned preview truth, never restate a
// dated census. Structural debt belongs in the publication catalogue and source
// contract, where the materialized checkout can validate it without private docs.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createSourceReleaseContract,
  parsePublicPolicyRegistry,
  parsePublicPublicationCatalog,
  validateSourceReleaseContract,
} from "./oss-publication-contract.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const paths = [
  "config/openlup-policy-registry.json",
  "config/openlup-publication-catalog.json",
  "config/openlup-source-release-contract.json",
] as const;

describe("the public README delegates preview truth to machine contracts", () => {
  const page = read("README.md");
  // The third path is deliberately NOT a markdown link any more: it is absent from this
  // repository, and `check-publishable-rootfile-links` refuses a dead link out of a published
  // front door. The README names it once, in prose, so both contracts hold at the same time.
  const policy = parsePublicPolicyRegistry(read(paths[0]));
  const catalogue = parsePublicPublicationCatalog(read(paths[1]));
  // The contract is computed, not tracked: the README still names the path because a materialized
  // preview carries it, and what this proves is the document the producer emits for THIS tree.
  const digest = `sha256-${"0".repeat(64)}`;
  const contractSource = createSourceReleaseContract({ inventoryDigest: digest, classDigest: digest, packageDigest: digest, rootLockDigest: digest, coreLockDigest: digest, migrationManifestDigest: digest, databaseTypesDigest: digest, policyRegistryDigest: digest, publicationCatalogDigest: digest }).contents;

  it("links every public integrity input exactly once", () => {
    for (const path of paths) {
      expect(page.match(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? [], path).toHaveLength(1);
    }
    expect(page).toContain("npm run oss:published-tree -- --policy");
  });

  it("states preview posture without reviving copied gap counts", () => {
    expect(page).toContain("## Status: development preview");
    expect(page).not.toContain("## Known Gaps In This Tree");
    expect(page).not.toMatch(/measured on \d{4}-\d{2}-\d{2}/u);
    expect(page).not.toMatch(/\b\d+ (?:unresolved|pinned deployment|consumer-side|prebuild)\b/iu);
  });

  it("keeps every public policy owner inside the public catalogue", () => {
    const published = new Set(catalogue.publicPaths.map(({ path }) => path));
    expect(policy.activePaths.every((path) => published.has(path))).toBe(true);
    expect(policy.contracts.every(({ owners }) => owners.length === 1 && published.has(owners[0]))).toBe(true);
  });

  it("carries the complete B1 guard disposition vocabulary", () => {
    expect(catalogue.guardViability.map(({ id }) => id)).toEqual([
      "browser-role",
      "env-defaults",
      "migration-header",
      "order-money",
      "pii",
      "publication-bridge-hold",
      "route-rpc-bff",
      "seam-default",
      "source-size-complexity",
      "vercel-specifiers",
    ]);
    expect(catalogue.guardViability.every((guard) => guard.status === "withheld" && guard.reason.trim() !== "")).toBe(true);
  });

  it("keeps the computed pre-act contract non-activating and non-circular", () => {
    expect(() => validateSourceReleaseContract(contractSource)).not.toThrow();
    const contract = JSON.parse(contractSource) as Record<string, unknown>;
    expect(contract).not.toHaveProperty("commit");
    expect(contract).not.toHaveProperty("tree");
    expect(contract).toMatchObject({
      repository: {
        coordinate: "https://openlup.invalid/source-release-fixture",
        securityRoute: "security@openlup.invalid",
      },
      release: { evidenceClass: "local-fixture", posture: "development-preview" },
    });
  });
});
