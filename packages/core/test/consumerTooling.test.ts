import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertCorePackagePortabilityProof } from "../scripts/core-package-consumer-audit.ts";
import { resolveDependencyRoots } from "../scripts/core-package-consumer-smoke.ts";

const requiredPackFiles = [
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "MAINTAINERS.md",
  "README.md",
  "SECURITY.md",
  "package.json",
  "release-gates.json",
  "dist/index.js",
];

// Pair the fixture with this package's metadata; the audit independently pins
// its exact approved wording before checking the deliberately injected leak.
const approvedDogfoodEvidence = JSON.parse(
  readFileSync(new URL("../release-gates.json", import.meta.url), "utf8"),
).evidence.dogfoodEvidence.meaning;

function assertArtifactRefused(path: string, source: string, reason: RegExp): void {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "core-package-audit-"));
  const sourceRoot = join(temporaryRoot, "source", "package");
  const extractedRoot = join(temporaryRoot, "extracted");
  try {
    for (const file of requiredPackFiles) {
      const absolute = join(sourceRoot, file);
      mkdirSync(dirname(absolute), { recursive: true });
      const content = file === path
        ? source
        : file === "release-gates.json"
          ? JSON.stringify({ evidence: { dogfoodEvidence: { meaning: approvedDogfoodEvidence } } })
          : "neutral package artifact\n";
      writeFileSync(absolute, content);
    }
    const tarballPath = join(temporaryRoot, "core.tgz");
    execFileSync("tar", ["-czf", tarballPath, "-C", join(temporaryRoot, "source"), "package"]);
    mkdirSync(extractedRoot);
    execFileSync("tar", ["-xzf", tarballPath, "-C", extractedRoot]);
    const packageRoot = join(extractedRoot, "package");
    expect(existsSync(packageRoot)).toBe(true);

    expect(() => assertCorePackagePortabilityProof({
      packageRoot,
      packageName: "@openlup/core",
      packageJson: {
        name: "@openlup/core",
        version: "0.1.0-rc.1",
        private: true,
        license: "Apache-2.0",
        files: ["LICENSE"],
        scripts: { prepack: "npm run build" },
        exports: {},
      },
      packageReadme: [
        "| Export | Role | Maturity | Package smoke |",
        "| `./subscription` | kernel | candidate |",
        "| `./bundle` | kernel | candidate |",
        "| `./pricing` | kernel | candidate |",
      ].join("\n"),
      packFiles: requiredPackFiles,
      approvedProofVersion: "0.1.0-rc.1",
    })).toThrow(reason);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

describe("packed consumer dependency roots", () => {
  it("accepts the package and its npm workspace root but rejects unrelated trees", () => {
    expect(resolveDependencyRoots("/repo/packages/core", {
      dependencyRoot: "/repo",
    })).toEqual(["/repo/packages/core", "/repo"]);
  });

  it("keeps an isolated package on its own root", () => {
    expect(resolveDependencyRoots("/candidate")).toEqual(["/candidate"]);
  });

  it.each([
    ["brand", "dist/index.js", "export const downstreamBrand = 'Velipet';"],
    ["brand camel identifier", "dist/index.js", "export const velipetInternalCheck = true;"],
    ["brand Pascal identifier", "dist/index.js", "export class VelipetAdapter {}"],
    ["owner brand", "dist/index.js", "export const downstreamOwnerBrand = 'Proteine Resources';"],
    ["owner brand identifier", "dist/index.js", "export const owner = 'ProteineResources';"],
    ["environment", "dist/index.js", "export const token = process.env.CORE_TOKEN;"],
    ["provider", "dist/index.js", "export const payment = 'stripe';"],
    ["provider OpenAI", "dist/index.js", "export const integration = 'OpenAI';"],
    ["provider GTM", "dist/index.js", "export const integration = 'GTM';"],
    ["provider googletagmanager", "dist/index.js", "export const integration = 'googletagmanager';"],
    ["provider Axiom", "dist/index.js", "export const integration = 'Axiom';"],
    ["provider Svix", "dist/index.js", "export const integration = 'Svix';"],
    ["provider Calendly", "dist/index.js", "export const integration = 'Calendly';"],
    ["owner path", "dist/index.js", "export const path = '/Users/owner/project';"],
    ["brand concatenation", "dist/index.js", "export const downstreamBrand = 've' + 'lipet';"],
    ["brand array join", "dist/index.js", "export const downstreamBrand = ['vel', 'ipet'].join('');"],
    ["owner brand concatenation", "dist/index.js", "export const downstreamOwner = 'pro' + 'teine' + ' resources';"],
    ["abbreviation concatenation", "dist/index.js", "export const prefix = 'VE' + 'LI-';"],
    ["extensionless license", "LICENSE", "Apache License\n\nProteine Resources"],
    [
      "unapproved policy field",
      "release-gates.json",
      JSON.stringify({
        evidence: { dogfoodEvidence: { meaning: approvedDogfoodEvidence } },
        accidentalProviderLeak: "stripe",
      }),
    ],
  ])("rejects packed artifact %s leakage", (_kind, path, source) => {
    assertArtifactRefused(path, source, /packed core tarball contains downstream leakage/);
  });

  it.each([
    ["missing", JSON.stringify({ evidence: { dogfoodEvidence: {} } })],
    ["rewritten", JSON.stringify({ evidence: { dogfoodEvidence: { meaning: "A public adopter has proved the platform seam." } } })],
  ])("refuses packed %s dogfood evidence", (_kind, source) => {
    assertArtifactRefused("release-gates.json", source, /dogfood evidence must retain its exact approved wording/);
  });
});
