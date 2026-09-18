import { existsSync, lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve, sep } from "node:path";

const expectedPolicies = ["internal-candidate", "testing-internal"];
const expectedConditions = [
  "core-source",
  "types",
  "module",
  "node",
  "development",
  "production",
  "import",
  "default",
];
const runtimeConditions = ["module", "node", "development", "production", "import", "default"];
const compatibilityByMaturity: Record<string, string> = {
  candidate: "internal-candidate",
  experimental: "internal-candidate",
  testing: "testing-internal",
};

type PackageSurfaceContract = {
  role: string;
  maturity: string;
  compatibilityPolicy: string;
  packageSmokeEvidence: string[];
  entrypoint: string;
  snapshot: string;
};

type PackageSurfaceConfigInput = {
  manifest: { exports: Record<string, Record<string, string>> };
  gates: {
    schemaVersion: number;
    compatibilityPolicies: Record<string, string>;
    packageSurface: Record<string, PackageSurfaceContract>;
    privatePackage: { activationTarget: string; publicStability: string; artifactChannel: string };
    evidence: Record<string, { state: string; meaning: string }>;
  };
  packageRoot: string;
  requireSnapshots?: boolean;
};

export function assertPackageSurfaceConfig({
  manifest,
  gates,
  packageRoot,
  requireSnapshots = true,
}: PackageSurfaceConfigInput): void {
  assert(gates.schemaVersion === 3, "unsupported release-gates.json schema");
  assert(
    gates.privatePackage.activationTarget === "platform-monorepo-phase-5" &&
      gates.privatePackage.publicStability === "not-claimed" &&
      gates.privatePackage.artifactChannel === "local-pack-only",
    "package surface must not claim a separate release or public API before phase 5",
  );
  assertEvidenceTaxonomy(gates.evidence);

  const exported = Object.keys(manifest.exports).sort();
  const inventoried = Object.keys(gates.packageSurface).sort();
  assert(isDeepStrictEqual(inventoried, exported), "package surface inventory must exactly match package exports");
  assert(
    isDeepStrictEqual(Object.keys(gates.compatibilityPolicies).sort(), expectedPolicies),
    `compatibility policies must be exactly ${expectedPolicies.join(", ")}`,
  );
  for (const [policy, description] of Object.entries(gates.compatibilityPolicies)) {
    assert(
      typeof description === "string" && description.trim().length > 0,
      `compatibility policy is empty: ${policy}`,
    );
  }

  const snapshots = new Set();
  for (const [subpath, contract] of Object.entries(gates.packageSurface)) {
    assert(["kernel", "testing"].includes(contract.role), `invalid package surface role for ${subpath}`);
    assert(compatibilityByMaturity[contract.maturity], `invalid package surface maturity for ${subpath}`);
    assert(
      contract.compatibilityPolicy === compatibilityByMaturity[contract.maturity],
      `compatibility policy differs from ${contract.maturity} policy for ${subpath}`,
    );
    assertPackageSmokeEvidence(packageRoot, subpath, contract.packageSmokeEvidence);
    assert(/^dist\/.+\.d\.ts$/.test(contract.entrypoint), `invalid declaration entrypoint for ${subpath}`);
    assert(/^api\/.+\.api\.md$/.test(contract.snapshot), `invalid API snapshot for ${subpath}`);
    assert(!snapshots.has(contract.snapshot), `duplicate API snapshot for ${subpath}`);
    snapshots.add(contract.snapshot);
    assertPackageFile(packageRoot, subpath, "declaration", contract.entrypoint);
    if (requireSnapshots) assertPackageFile(packageRoot, subpath, "snapshot", contract.snapshot);

    const exportEntry = manifest.exports[subpath];
    assert(
      isDeepStrictEqual(Object.keys(exportEntry), expectedConditions),
      `export condition order drifted for ${subpath}`,
    );
    assert(/^\.\/src\/.+\.ts$/.test(exportEntry["core-source"]), `invalid authoring source target for ${subpath}`);
    const expectedRuntimeTarget = exportEntry["core-source"]
      .replace("./src/", "./dist/")
      .replace(/\.ts$/, ".js");
    for (const condition of runtimeConditions) {
      assert(exportEntry[condition] === expectedRuntimeTarget, `${condition} target differs from built output for ${subpath}`);
    }
    const expectedTypeTarget = expectedRuntimeTarget.replace(/\.js$/, ".d.ts");
    assert(exportEntry.types === expectedTypeTarget, `types target differs from built declaration for ${subpath}`);
    assert(contract.entrypoint === exportEntry.types.slice(2), `declaration entrypoint differs from types export for ${subpath}`);
  }
  console.log(`package surface inventory ok (${inventoried.length} exports; public stability not claimed)`);
}

function assertEvidenceTaxonomy(evidence: PackageSurfaceConfigInput["gates"]["evidence"]): void {
  const expectedStates = {
    packageSmokeEvidence: "required",
    conformanceEvidence: "required-for-declared-ports",
    dogfoodEvidence: "private-current-seams",
    externalConsumerEvidence: "not-evaluated",
  };
  assert(
    isDeepStrictEqual(Object.keys(evidence).sort(), Object.keys(expectedStates).sort()),
    "evidence taxonomy must distinguish package smoke, conformance, dogfood, and optional external consumer evidence",
  );
  for (const [name, state] of Object.entries(expectedStates)) {
    const item = evidence[name];
    assert(
      item?.state === state && typeof item.meaning === "string" && item.meaning.trim().length > 0,
      `evidence taxonomy drifted for ${name}`,
    );
  }
  assert(
    /real independent adopter|public platform artifact/i.test(evidence.externalConsumerEvidence.meaning) &&
      /first-party packed consumers remain package smoke evidence/i.test(evidence.externalConsumerEvidence.meaning),
    "external consumer evidence must exclude first-party packed consumers",
  );
}

function assertPackageSmokeEvidence(packageRoot: string, subpath: string, evidence: string[]): void {
  assert(Array.isArray(evidence) && evidence.length > 0, `missing package smoke evidence for ${subpath}`);
  for (const path of evidence) {
    assert(typeof path === "string" && path.length > 0, `invalid package smoke evidence for ${subpath}`);
    assert(
      /^(?:smoke|test)\/.+\.test\.ts$/.test(path),
      `package smoke evidence must be a package-owned test for ${subpath}: ${path}`,
    );
    assertPackageFile(packageRoot, subpath, "package smoke evidence", path);
  }
}

function assertPackageFile(packageRoot: string, subpath: string, kind: string, path: string): void {
  const absolute = resolve(packageRoot, path);
  assert(absolute.startsWith(`${packageRoot}${sep}`), `${kind} escapes package for ${subpath}: ${path}`);
  assert(existsSync(absolute) && lstatSync(absolute).isFile(), `${kind} is missing for ${subpath}: ${path}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
