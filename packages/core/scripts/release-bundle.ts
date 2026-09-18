import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = { name: string; version: string };
type PackReport = { filename: string; integrity: string };
type CycloneDxComponent = {
  "bom-ref"?: string;
  name?: string;
  purl?: string;
  version?: string;
  [key: string]: unknown;
};
type CycloneDxSbom = {
  bomFormat?: string;
  metadata?: {
    component?: CycloneDxComponent;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type ReleaseBundleManifest = {
  schemaVersion: 1;
  package: { name: string; version: string };
  source: { commit: string; tree: string };
  artifacts: {
    tarball: { filename: string; sha256: string; integrity: string };
    sbom: { filename: string; sha256: string; format: "CycloneDX" };
    checksums: { filename: "SHA256SUMS" };
  };
  toolchain: { node: string; npm: string };
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeReleaseSbom(
  sbom: CycloneDxSbom,
  manifest: PackageManifest,
  expectedDirectoryName: string,
  sourceTimestamp: string,
): CycloneDxSbom {
  assertReleaseSbomIdentity(sbom, manifest, expectedDirectoryName);
  const parsedTimestamp = Date.parse(sourceTimestamp);
  assert(
    !Number.isNaN(parsedTimestamp) && new Date(parsedTimestamp).toISOString() === sourceTimestamp,
    "release SBOM source timestamp must be canonical ISO-8601",
  );
  const component = sbom.metadata?.component;
  assert(component, "npm sbom must identify its root component");
  const { serialNumber: _volatileSerialNumber, ...stableSbom } = sbom;

  return {
    ...stableSbom,
    metadata: {
      ...sbom.metadata,
      timestamp: sourceTimestamp,
      component: { ...component, name: manifest.name },
    },
  };
}

export function assertReleaseSbomIdentity(
  sbom: CycloneDxSbom,
  manifest: PackageManifest,
  expectedDirectoryName: string,
): void {
  assert(sbom.bomFormat === "CycloneDX", "npm sbom must emit CycloneDX");
  const component = sbom.metadata?.component;
  assert(component, "npm sbom must identify its root component");
  assert(
    component["bom-ref"] === `${manifest.name}@${manifest.version}`,
    "npm sbom root bom-ref must match the release manifest",
  );
  assert(
    component.purl === npmPackagePurl(manifest),
    "npm sbom root purl must match the release manifest",
  );
  assert(
    component.version === manifest.version,
    "npm sbom root version must match the release manifest",
  );
  assert(
    component.name === manifest.name || component.name === expectedDirectoryName,
    "npm sbom root name must match the release manifest or checkout directory",
  );
}

export function createReleaseBundleManifest(input: {
  packageManifest: PackageManifest;
  sourceCommit: string;
  sourceTree: string;
  tarballFilename: string;
  tarballBytes: Buffer;
  tarballIntegrity: string;
  sbomFilename: string;
  sbomBytes: Buffer;
  npmVersion: string;
}): ReleaseBundleManifest {
  return {
    schemaVersion: 1,
    package: {
      name: input.packageManifest.name,
      version: input.packageManifest.version,
    },
    source: { commit: input.sourceCommit, tree: input.sourceTree },
    artifacts: {
      tarball: {
        filename: input.tarballFilename,
        sha256: sha256(input.tarballBytes),
        integrity: input.tarballIntegrity,
      },
      sbom: {
        filename: input.sbomFilename,
        sha256: sha256(input.sbomBytes),
        format: "CycloneDX",
      },
      checksums: { filename: "SHA256SUMS" },
    },
    toolchain: { node: process.version, npm: input.npmVersion },
  };
}

export function writeReleaseBundle(outputPath = "release"): ReleaseBundleManifest {
  const outputRoot = resolve(packageRoot, outputPath);
  assert(
    outputRoot === resolve(packageRoot, "release") ||
      outputRoot.startsWith(`${resolve(packageRoot, "release")}${sep}`),
    "release output must stay inside packages/core/release",
  );
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const gitRoot = run("git", ["rev-parse", "--show-toplevel"], packageRoot).trim();
  const packagePath = relative(gitRoot, packageRoot) || ".";
  assert(
    run("git", ["status", "--porcelain", "--untracked-files=all", "--", packagePath], gitRoot).trim() === "",
    "release bundle requires a clean committed package tree",
  );

  const manifest = readJson<PackageManifest>(resolve(packageRoot, "package.json"));
  const sourceCommit = run("git", ["rev-parse", "HEAD"], packageRoot).trim();
  const sourceTree = run(
    "git",
    ["rev-parse", packagePath === "." ? "HEAD^{tree}" : `HEAD:${packagePath}`],
    gitRoot,
  ).trim();
  const sourceCommitSeconds = run("git", ["show", "-s", "--format=%ct", sourceCommit], gitRoot).trim();
  assert(/^\d+$/.test(sourceCommitSeconds), "source commit timestamp is invalid");
  const sourceTimestamp = new Date(Number(sourceCommitSeconds) * 1_000).toISOString();
  const packReports = JSON.parse(
    runNpm(["pack", "--json", "--pack-destination", outputRoot, "--workspaces=false"]),
  ) as PackReport[];
  assert(packReports.length === 1, "npm pack must emit exactly one artifact");

  const tarball = packReports[0];
  const tarballBytes = readFileSync(resolve(outputRoot, tarball.filename));
  const sbomFilename = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.cdx.json`;
  const sbomText = runNpm([
    "sbom",
    "--omit=dev",
    "--package-lock-only",
    "--sbom-format=cyclonedx",
    "--sbom-type=library",
    "--workspaces=false",
  ]);
  const sbom = normalizeReleaseSbom(
    JSON.parse(sbomText) as CycloneDxSbom,
    manifest,
    basename(packageRoot),
    sourceTimestamp,
  );
  const normalizedSbom = `${JSON.stringify(sbom, null, 2)}\n`;
  const sbomPath = resolve(outputRoot, sbomFilename);
  writeFileSync(sbomPath, normalizedSbom);

  const bundle = createReleaseBundleManifest({
    packageManifest: manifest,
    sourceCommit,
    sourceTree,
    tarballFilename: tarball.filename,
    tarballBytes,
    tarballIntegrity: tarball.integrity,
    sbomFilename,
    sbomBytes: Buffer.from(normalizedSbom),
    npmVersion: runNpm(["--version"]).trim(),
  });
  const checksums = [
    `${bundle.artifacts.tarball.sha256}  ${bundle.artifacts.tarball.filename}`,
    `${bundle.artifacts.sbom.sha256}  ${bundle.artifacts.sbom.filename}`,
  ].join("\n");
  writeFileSync(resolve(outputRoot, "SHA256SUMS"), `${checksums}\n`);
  writeFileSync(resolve(outputRoot, "release-manifest.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function runNpm(args: string[]): string {
  const cache = mkdtempSync(resolve(tmpdir(), "openlup-release-cache-"));
  try {
    return run("npm", [...args, "--cache", cache], packageRoot);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function readJson<Parsed>(path: string): Parsed {
  return JSON.parse(readFileSync(path, "utf8")) as Parsed;
}

function npmPackagePurl(manifest: PackageManifest): string {
  return `pkg:npm/${manifest.name.replace(/^@/, "%40")}@${manifest.version}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = writeReleaseBundle(process.argv[2]);
  console.log(`release bundle ok (${bundle.package.name}@${bundle.package.version})`);
}
