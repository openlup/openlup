import { describe, expect, it } from "vitest";
import { parseStorefrontVerdict, type StorefrontVerdict } from "../../src/lifecycle/index.js";
import { sameStorefrontBuild } from "../../src/lifecycle/storefrontBuildIdentity.js";

type Build = StorefrontVerdict["build"];
const web = `sha256:${"0".repeat(64)}`, admin = `sha256:${"1".repeat(64)}`, proof = `sha256:${"2".repeat(64)}`;

function identity(): Build {
  return {
    source: "ci",
    packages: [{ name: "@openlup/core", version: "1.0.0", integrity: "sha512-AAAA" }, { name: "@openlup/platform", version: "1.0.0", integrity: "sha512-BBBB" }],
    clients: [{ name: "web", digest: web }, { name: "admin", digest: admin }],
    proofFile: proof,
  };
}

describe("sameStorefrontBuild", () => {
  it("B1 compares packages and clients as sets and ignores source", () => {
    const a = identity();
    const reordered: Build = { ...a, packages: [...a.packages].reverse(), clients: [...a.clients].reverse() };
    expect(sameStorefrontBuild(a, reordered)).toBe(true);
    expect(sameStorefrontBuild(a, { ...a, source: "claimed" })).toBe(true);
  });

  it("B1 tells apart a changed version, one-sided integrity, a client digest and the proof file", () => {
    const a = identity();
    const variants: Build[] = [
      { ...a, packages: [{ ...a.packages[0]!, version: "1.0.1" }, a.packages[1]!] },
      { ...a, packages: [{ name: "@openlup/core", version: "1.0.0" }, a.packages[1]!] },
      { ...a, clients: [{ name: "web", digest: proof }, a.clients[1]!] },
      { ...a, proofFile: null },
      { ...a, packages: [a.packages[0]!] },
    ];
    variants.push({ ...a, packages: [{ ...a.packages[0]!, integrity: "sha512-AAAA sha1-CCCC" }, a.packages[1]!] });
    for (const variant of variants) {
      expect(sameStorefrontBuild(a, variant), JSON.stringify(variant)).toBe(false);
      expect(sameStorefrontBuild(variant, a)).toBe(false);
    }
  });

  it("B1 has the parser refuse an integrity that is not a full SRI string", () => {
    const verdict = {
      formatVersion: 1, runId: "run", completedAt: "2025-06-01T00:00:00.000Z", scenario: "duplicate_submit", tier: "fixture_preview",
      profile: "default", channel: "agent_protocol", result: "safety_only", control: { kind: "none", negates: null, applied: false },
      stimulus: {}, steps: [], findings: [], build: identity(),
      harness: { runnerVersion: "1.0.0", catalogueVersion: 1, adapter: { kind: "default", fields: [], digest: null }, autoProgress: [], observer: "fixture", declaredOutcomes: [] },
      durations: { totalMs: 0, byPhase: {} },
    };
    expect(parseStorefrontVerdict(JSON.stringify(verdict)).ok).toBe(true);
    // An npm-style list of hash expressions is accepted when it holds at least one SHA-2 hash; it is compared as written.
    for (const integrity of ["sha512-AAAA", "sha1-AAAA sha512-BBBB==", "sha512-AAAA sha1-BBBB", "sha256-AAAA sha384-BBBB sha512-CCCC", "sha512-AAAA?opt"]) {
      const build = { ...identity(), packages: [{ name: "@openlup/core", version: "1.0.0", integrity }] };
      expect(parseStorefrontVerdict(JSON.stringify({ ...verdict, build })).ok, integrity).toBe(true);
    }
    for (const integrity of ["AAAA", "sha1-AAAA", "sha1-AAAA sha1-BBBB", "sha512-", "sha512-AA AA", "md5-AAAA", " sha512-AAAA", "sha512-AAAA ", "sha512-AAAA\tsha1-BBBB", "sha512-AAAA,sha1-BBBB"]) {
      const build = { ...identity(), packages: [{ name: "@openlup/core", version: "1.0.0", integrity }] };
      const result = parseStorefrontVerdict(JSON.stringify({ ...verdict, build }));
      expect(result.ok ? null : result.refusal.observed, integrity).toBe("build.packages.0.integrity");
    }
  });
});
