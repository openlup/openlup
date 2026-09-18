import { isDeepStrictEqual } from "node:util";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPackageSurfaceConfig } from "./public-api-config.ts";
import { createNpmReleaseChecks } from "./release-npm-checks.ts";
import { verifyRepositoryPolicy } from "./repository-policy-check.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readJson("package.json");
const gates = readJson("release-gates.json");
const lock = readJson("package-lock.json");
const mode = process.argv[2] ?? "all";
const npmChecks = createNpmReleaseChecks({
  packageRoot,
  manifest,
  gates,
  lock,
});

const checks = {
  lock: checkLock,
  licenses: checkLicenses,
  sbom: npmChecks.sbom,
  audit: npmChecks.audit,
  pack: npmChecks.pack,
  publish: checkPublishBlock,
  "repository-policy": () => verifyRepositoryPolicy({ packageRoot, manifest }),
};

assert(mode === "all" || checks[mode], `unknown release check: ${mode}`);

if (mode === "all") {
  checkReleaseIdentity();
  assertPackageSurfaceConfig({ manifest, gates, packageRoot });
  for (const check of Object.values(checks)) check();
} else {
  checks[mode]();
}

function checkReleaseIdentity() {
  assert(
    manifest.version === gates.privatePackage?.proofVersion,
    `package version must match approved private proof ${gates.privatePackage?.proofVersion ?? "<missing>"}`,
  );
  assert(
    gates.privatePackage?.activationTarget === "platform-monorepo-phase-5" &&
      gates.privatePackage?.publicStability === "not-claimed" &&
      gates.privatePackage?.artifactChannel === "local-pack-only",
    "private package proof must not claim a separate release or public API before phase 5",
  );
  console.log(`private package identity ok (${manifest.version}, local-pack-only)`);
}

function checkLock() {
  assert(
    lock.lockfileVersion === 3,
    "package-lock.json must use lockfileVersion 3",
  );
  assert(lock.requires === true, "package-lock.json must set requires=true");
  assert(lock.name === manifest.name, "lock name differs from package.json");
  assert(
    lock.version === manifest.version,
    "lock version differs from package.json",
  );

  const root = lock.packages?.[""];
  assert(root, "package-lock.json is missing its root package entry");
  for (const field of [
    "name",
    "version",
    "license",
    "engines",
    "dependencies",
    "devDependencies",
  ]) {
    assert(
      isDeepStrictEqual(root[field], manifest[field]),
      `lock root ${field} differs from package.json`,
    );
  }

  for (const [path, entry] of Object.entries(lock.packages)) {
    assert(
      path === "" || path.startsWith("node_modules/"),
      `non-local lock package path: ${path}`,
    );
    assert(
      entry.link !== true,
      `workspace/link dependency is forbidden in lock: ${path}`,
    );
    if (typeof entry.resolved === "string") {
      assert(
        !/^(file:|link:|workspace:)/.test(entry.resolved),
        `local dependency resolution is forbidden in lock: ${path}`,
      );
    }
  }

  for (const specifier of Object.values({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  })) {
    assert(
      typeof specifier === "string" &&
        !/^(file:|link:|workspace:)/.test(specifier),
      `local dependency specifier is forbidden: ${specifier}`,
    );
  }

  for (const artifact of gates.requiredRepositoryArtifacts) {
    const path = resolveInsidePackage(artifact);
    assert(
      existsSync(path) && lstatSync(path).isFile(),
      `missing release artifact: ${artifact}`,
    );
  }
  console.log("standalone lock and release artifacts ok");
}

function checkLicenses() {
  const allowed = new Set(gates.productionLicenses.allow);
  const production = productionLockEntries();
  const violations = [];

  for (const [path, entry] of production) {
    const license = path === "" ? manifest.license : entry.license;
    if (typeof license !== "string" || !allowed.has(license)) {
      violations.push(`${path || manifest.name}: ${license ?? "missing"}`);
    }
  }

  assert(
    violations.length === 0,
    `production license allowlist violations:\n${violations.join("\n")}`,
  );
  console.log(`production licenses ok (${production.length} packages)`);
}

function checkPublishBlock() {
  assert(
    manifest.private === gates.publish.private && manifest.private === true,
    "package must remain private=true",
  );
  assert(
    manifest.publishConfig?.registry === gates.publish.blockedRegistry,
    "publishConfig.registry must remain on the blocked local registry",
  );
  assert(
    manifest.scripts?.prepublishOnly === gates.publish.prepublishOnly,
    "prepublishOnly must remain the configured lifecycle refusal",
  );

  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      resolveInsidePackage("scripts/refuse-publish.ts"),
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert(result.status !== 0, "publish refusal script unexpectedly succeeded");
  assert(
    output.includes(gates.publish.refusalMarker),
    "publish refusal marker was not emitted",
  );
  console.log(
    "private manifest, blocked registry, and publish lifecycle refusal ok",
  );
}

function productionLockEntries() {
  return Object.entries(lock.packages).filter(
    ([, entry]) => entry.dev !== true,
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(resolveInsidePackage(path), "utf8"));
}

function resolveInsidePackage(path) {
  const absolute = resolve(packageRoot, path);
  assert(
    absolute === packageRoot || absolute.startsWith(`${packageRoot}${sep}`),
    `path escapes package root: ${path}`,
  );
  return absolute;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
