import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GOVERNED_FLAG_NAMES } from "../server/_lib/config/flagNames.ts";
import { carriesPrivateOperationalCoordinate } from "./oss-neutralization-projection.ts";
import { projectPublicFeatureFlags, projectPublicGitleaks, projectPublicLegacyMoneyExceptions, projectPublicPlatformRuntime } from "./oss-public-config-projection.ts";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("mixed deployment configuration projections", () => {
  it("publishes empty adopter-owned state instead of Velipet defaults", () => {
    const projections = [
      projectPublicLegacyMoneyExceptions(source("config/canonical-order-money-legacy-exceptions.json")),
      projectPublicFeatureFlags(source("config/feature-flags.json")),
      projectPublicPlatformRuntime(source("config/platform-runtime.json")),
      projectPublicGitleaks(source("config/gitleaks.toml")),
    ];
    expect(projections.map(({ path }) => path)).toEqual([
      "config/canonical-order-money-legacy-exceptions.json", "config/feature-flags.json",
      "config/platform-runtime.json", "config/gitleaks.toml",
    ]);
    expect(projections.every(({ contents }) => !carriesPrivateOperationalCoordinate(contents))).toBe(true);
    expect(JSON.parse(projections[0].contents).exceptions).toEqual([]);
    expect(JSON.parse(projections[1].contents).flags).toEqual([...GOVERNED_FLAG_NAMES].sort().map((name) => ({ name })));
    expect(Object.keys(JSON.parse(projections[1].contents).flags[0])).toEqual(["name"]);
    expect(JSON.parse(projections[2].contents).crons).toEqual([]);
    expect(projections[3].contents).not.toMatch(/op:\/\//u);
  });

  it("refuses a missing or duplicate governed source name", () => {
    const registry = JSON.parse(source("config/feature-flags.json"));
    const governed = GOVERNED_FLAG_NAMES[0]!;
    expect(() => projectPublicFeatureFlags(JSON.stringify({ ...registry, flags: registry.flags.filter((row: { name: string }) => row.name !== governed) }))).toThrow(/governed flag.*missing/u);
    expect(() => projectPublicFeatureFlags(JSON.stringify({ ...registry, flags: [...registry.flags, registry.flags[0]] }))).toThrow(/must be unique/u);
  });
});
