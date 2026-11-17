import { existsSync, lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve, sep } from "node:path";

const expectedPolicies = ["experimental", "stable", "testing"];
export const packageKinds = ["kernel", "rail", "capability", "implementation"];
// Packages retain one coherent set version; SemVer applies to stable APIs from 1.0.0.
export const setVersionRule = "MAJOR.MINOR.PATCH";
const setVersion = /^(?:0\.[1-9]\d*|[1-9]\d*\.(?:0|[1-9]\d*))\.(?:0|[1-9]\d*)$/;

export function isSetVersion(version: unknown): boolean {
  return typeof version === "string" && setVersion.test(version);
}

export function assertSetVersion(versionRule: unknown, version: unknown): void {
  assert(
    versionRule === setVersionRule && isSetVersion(version),
    `package version must be a set version ${setVersionRule}, not ${String(version)}`,
  );
}

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
  stable: "stable",
  experimental: "experimental",
  testing: "testing",
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
  manifest: { exports: Record<string, string | Record<string, string>> };
  gates: {
    schemaVersion: number;
    kind?: unknown;
    compatibilityPolicies: Record<string, string>;
    packageSurface: Record<string, PackageSurfaceContract>;
    packageRelease: { phase: string; publicStability: string; artifactChannel: string; versionRule: string };
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
  assert(gates.schemaVersion === 5, "unsupported release-gates.json schema");
  assert(
    typeof gates.kind === "string" && packageKinds.includes(gates.kind),
    `package kind must be one of ${packageKinds.join(", ")}`,
  );
  assert(
    gates.packageRelease.phase === "platform-monorepo-phase-5" &&
      gates.packageRelease.publicStability === "stable-semver" &&
      gates.packageRelease.artifactChannel === "npm-stable" &&
      gates.packageRelease.versionRule === setVersionRule,
    "package surface must declare stable SemVer and the stable npm channel",
  );
  assertEvidenceTaxonomy(gates.evidence);

  const { "./package.json": manifestExport, ...codeExports } = manifest.exports;
  assert(manifestExport === "./package.json", "the manifest is exported as ./package.json for tooling");
  const exported = Object.keys(codeExports).sort();
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
    assert(Object.hasOwn(compatibilityByMaturity, contract.maturity), `invalid package surface maturity for ${subpath}`);
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

    const exportEntry = codeExports[subpath] as Record<string, string>;
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
  console.log(`package surface inventory ok (${inventoried.length} exports; stable SemVer from 1.0.0)`);
}

function assertEvidenceTaxonomy(evidence: PackageSurfaceConfigInput["gates"]["evidence"]): void {
  const expectedStates = {
    packageSmokeEvidence: "required",
    conformanceEvidence: "required-for-declared-ports",
    dogfoodEvidence: "first-party-production",
    externalConsumerEvidence: "first-party-npm-and-production",
  };
  assert(
    isDeepStrictEqual(Object.keys(evidence).sort(), Object.keys(expectedStates).sort()),
    "evidence taxonomy must distinguish package smoke, conformance, dogfood, and first-party consumer evidence",
  );
  for (const [name, state] of Object.entries(expectedStates)) {
    const item = evidence[name];
    assert(
      item?.state === state && typeof item.meaning === "string" && item.meaning.trim().length > 0,
      `evidence taxonomy drifted for ${name}`,
    );
  }
  assert(
    /first-party demo store installed from npm/i.test(evidence.externalConsumerEvidence.meaning) &&
      /first-party production deployment/i.test(evidence.externalConsumerEvidence.meaning) &&
      /no independent adoption is claimed/i.test(evidence.externalConsumerEvidence.meaning),
    "consumer evidence must state first-party npm and production use without claiming independent adoption",
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
