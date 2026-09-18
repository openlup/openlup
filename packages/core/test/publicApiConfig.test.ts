import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertPackageSurfaceConfig } from "../scripts/public-api-config.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const gates = JSON.parse(readFileSync(resolve(packageRoot, "release-gates.json"), "utf8"));

function cloneGates(): typeof gates {
  return structuredClone(gates);
}

describe("private package surface configuration", () => {
  it("accepts the complete current export inventory without claiming public stability", () => {
    expect(() => assertPackageSurfaceConfig({ manifest, gates, packageRoot })).not.toThrow();
  });

  it("rejects empty compatibility policy descriptions", () => {
    const candidate = cloneGates();
    candidate.compatibilityPolicies["internal-candidate"] = "";
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      /compatibility policy is empty: internal-candidate/,
    );
  });

  it("rejects package smoke evidence that is not a package-owned test", () => {
    const candidate = cloneGates();
    candidate.packageSurface["./subscription"].packageSmokeEvidence = ["README.md"];
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      /package smoke evidence must be a package-owned test/,
    );
  });

  it("rejects conflating a first-party packed consumer with external consumer evidence", () => {
    const candidate = cloneGates();
    candidate.evidence.externalConsumerEvidence.meaning = "A packed first-party consumer proves public adoption.";
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      /external consumer evidence must exclude first-party packed consumers/,
    );
  });
});
