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

describe("package surface configuration", () => {
  it("accepts the complete current export inventory with stable SemVer", () => {
    expect(() => assertPackageSurfaceConfig({ manifest, gates, packageRoot })).not.toThrow();
  });

  it("rejects empty compatibility policy descriptions", () => {
    const candidate = cloneGates();
    candidate.compatibilityPolicies["stable"] = "";
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      /compatibility policy is empty: stable/,
    );
  });

  it("rejects package smoke evidence that is not a package-owned test", () => {
    const candidate = cloneGates();
    candidate.packageSurface["./subscription"].packageSmokeEvidence = ["README.md"];
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      /package smoke evidence must be a package-owned test/,
    );
  });

  it("rejects consumer evidence without the explicit first-party boundary", () => {
    const candidate = cloneGates();
    candidate.evidence.externalConsumerEvidence.meaning = "A packed first-party consumer proves public adoption.";
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      /consumer evidence must state first-party npm and production use without claiming independent adoption/,
    );
  });

  it.each(["candidate", "unknown", "toString", "__proto__"])("rejects maturity %s", (maturity) => {
    const candidate = cloneGates();
    candidate.packageSurface["./subscription"].maturity = maturity;
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(/invalid package surface maturity/);
  });

  it.each(["stable", "experimental", "testing"])("admits the %s policy and refuses a mismatched policy", (maturity) => {
    const candidate = cloneGates();
    Object.assign(candidate.packageSurface["./subscription"], { maturity, compatibilityPolicy: maturity });
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).not.toThrow();
    candidate.packageSurface["./subscription"].compatibilityPolicy = "unknown";
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(/compatibility policy differs/);
  });

  it.each(["publicStability", "artifactChannel", "phase", "versionRule"])("rejects an unknown release %s", (field) => {
    const candidate = cloneGates();
    candidate.packageRelease[field] = "unknown";
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(/must declare stable SemVer/);
  });

  it.each(Object.keys(gates.evidence))("rejects an unknown %s state", (name) => {
    const candidate = cloneGates();
    candidate.evidence[name].state = "unknown";
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(/evidence taxonomy drifted/);
  });

  it("rejects a release-gates schema older than 5", () => {
    const candidate = cloneGates();
    candidate.schemaVersion = 4;
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      /unsupported release-gates.json schema/,
    );
  });

  it.each([undefined, "library"])("rejects a package kind of %s", (kind) => {
    const candidate = cloneGates();
    candidate.kind = kind;
    expect(() => assertPackageSurfaceConfig({ manifest, gates: candidate, packageRoot })).toThrow(
      "package kind must be one of kernel, rail, capability, implementation",
    );
  });
});
