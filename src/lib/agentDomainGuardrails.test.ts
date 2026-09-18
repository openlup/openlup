import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Repo-wide guardrails for the agent-operable domain kit (Wave 4.5). Kept in a
 * standalone file (not appended to `architectureGuardrails.test.ts`, which is at
 * its legacy LOC cap) so the kit's invariants are machine-checked for every
 * future domain:
 *   - `kitIsDomainNeutral`     — the neutral kit homes import nothing from a domain.
 *   - `referenceBannerPresent` — catalog is bannered REFERENCE; Promotions is
 *                                bannered NOT-the-reference.
 */

const repoRoot = process.cwd();

/** Domain-neutral kit homes: must never import from `src|api/domains`. */
const KIT_ROOTS = ["server/_lib/admin-domain", "src/lib/agent-domain"];

/** Catalog is the canonical reference vertical. */
const REFERENCE_TOKEN = "@agent-domain-reference";
const REFERENCE_FILES = [
  "src/domains/commerce/adminCatalogContracts.ts",
  "src/domains/commerce/catalogRules.ts",
  "src/domains/commerce/catalogRuleCodes.ts",
  "src/domains/commerce/catalogSpec.ts",
  "server/domains/commerce/adminCatalogHandler.ts",
  "server/domains/commerce/adminCatalogDataPort.ts",
  "server/adapters/supabase/adminCatalog.ts",
];

/** Promotions is the back-compat harness — explicitly NOT the reference. */
const ANTI_TOKEN = "@agent-domain-anti-reference";
const ANTI_FILES = [
  "server/domains/commerce/adminPromotionsHandler.ts",
  "server/domains/commerce/adminPromotionsDataPort.ts",
  "server/adapters/supabase/adminPromotions.ts",
];

function readTsFiles(dir: string): string[] {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return readTsFiles(rel);
    return /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:type\s+)?[^"']+\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.add(match[1]);
  }
  return [...specs];
}

/** Returns the `src|api/domains/<d>/...` path a specifier resolves to, or null. */
function resolvesToDomain(importerRel: string, specifier: string): string | null {
  if (/^@\/domains\//.test(specifier)) return specifier;
  if (!specifier.startsWith(".")) return null;
  const absolute = join(dirname(join(repoRoot, importerRel)), specifier);
  const rel = relative(repoRoot, absolute).split(sep).join("/");
  return /^(?:src|api)\/domains\//.test(rel) ? rel : null;
}

describe("agent-operable domain kit guardrails", () => {
  it("kitIsDomainNeutral: neutral homes import nothing from a domain", () => {
    const files = KIT_ROOTS.flatMap(readTsFiles).filter((f) => !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      importSpecifiers(readFileSync(join(repoRoot, file), "utf8"))
        .map((spec) => ({ spec, target: resolvesToDomain(file, spec) }))
        .filter((x) => x.target)
        .map((x) => `${file} -> ${x.spec}`),
    );

    expect(violations).toEqual([]);
  });

  it("referenceBannerPresent: catalog is REFERENCE, Promotions is anti-bannered", () => {
    const missingReference = REFERENCE_FILES.filter(
      (file) => !readFileSync(join(repoRoot, file), "utf8").includes(REFERENCE_TOKEN),
    );
    const missingAnti = ANTI_FILES.filter(
      (file) => !readFileSync(join(repoRoot, file), "utf8").includes(ANTI_TOKEN),
    );

    expect({ missingReference, missingAnti }).toEqual({ missingReference: [], missingAnti: [] });
  });
});
