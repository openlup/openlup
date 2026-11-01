import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectOutcomeProjection, renderOutcomeProjection, runOutcomeProjection } from "./generate-outcome-projection.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = resolve(".context/scratch/outcome-projection");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  put("config/openlup-packages.json", { schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: true }], unreleased: [] });
  put("packages/core/package.json", { name: "@openlup/core", version: "0.36.0", exports: { "./subscription": "./dist/subscription.js" } });
  put("packages/core/release-gates.json", { packageSurface: { "./subscription": { snapshot: "api/subscription.api.md", packageSmokeEvidence: ["smoke/subscription.test.ts"] } } });
  put("packages/core/api/subscription.api.md", "Synthetic public API\n");
  put("packages/core/smoke/subscription.test.ts", "throw new Error('unexecuted synthetic witness');\n");
  return { root, put };
}

describe("neutral outcome projection", () => {
  it("keeps an existing but unexecuted witness partial and blocks the claim", () => {
    const { root } = fixture();
    const projection = collectOutcomeProjection(root);
    expect(projection.state).toBe("partial");
    expect(projection.claimable).toBe(false);
    expect(projection.outcomes[0]!.proofs[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const rendered = renderOutcomeProjection(projection);
    expect(rendered).toContain("Outcome claim blocked");
    expect(rendered).toContain("../../packages/core/smoke/subscription.test.ts");
    expect(rendered).not.toContain(root);
    expect(renderOutcomeProjection(collectOutcomeProjection(root))).toBe(rendered);
  });

  it("exposes a missing witness and changes its fingerprint after a proof-source change", () => {
    const { root, put } = fixture();
    const before = collectOutcomeProjection(root);
    put("packages/core/smoke/subscription.test.ts", "Synthetic changed witness\n");
    expect(collectOutcomeProjection(root).sourceDigest).not.toBe(before.sourceDigest);
    rmSync(join(root, "packages/core/smoke/subscription.test.ts"));
    const missing = collectOutcomeProjection(root);
    expect(missing.state).toBe("missing");
    expect(missing.claimable).toBe(false);
    expect(missing.outcomes[0]!.proofs[0]!.sha256).toBeNull();
    put("packages/core/smoke/subscription.test.ts", "Synthetic restored witness\n");
    rmSync(join(root, "packages/core/api/subscription.api.md"));
    const missingApi = collectOutcomeProjection(root);
    expect(missingApi.state).toBe("missing");
    expect(missingApi.outcomes[0]!.snapshot.sha256).toBeNull();
    expect(missingApi.outcomes[0]!.proofs[0]!.sha256).not.toBeNull();
  });

  it("refuses a silently omitted export or an escaped proof path", () => {
    const { root, put } = fixture();
    const manifest = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"));
    manifest.exports["./new-entry"] = "./dist/new-entry.js";
    put("packages/core/package.json", manifest);
    expect(() => collectOutcomeProjection(root)).toThrow(/inventory mismatch/u);
    delete manifest.exports["./new-entry"];
    put("packages/core/package.json", manifest);
    put("packages/core/release-gates.json", { packageSurface: { "./subscription": { snapshot: "api/subscription.api.md", packageSmokeEvidence: ["../outside.ts"] } } });
    expect(() => collectOutcomeProjection(root)).toThrow(/unsafe proof path/u);
  });

  it("groups a class without dropping exports or hiding a missing provider witness", () => {
    const { root, put } = fixture();
    put("packages/core/package.json", { name: "@openlup/core", version: "0.36.0", exports: { "./payment/provider-one": "./one.js", "./payment/provider-two": "./two.js" } });
    put("packages/core/release-gates.json", { packageSurface: {
      "./payment/provider-one": { snapshot: "api/one.api.md", packageSmokeEvidence: ["smoke/payment/one.test.ts"] },
      "./payment/provider-two": { snapshot: "api/two.api.md", packageSmokeEvidence: ["smoke/payment/two.test.ts"] },
    } });
    put("packages/core/api/one.api.md", "Synthetic API");
    put("packages/core/api/two.api.md", "Synthetic API");
    put("packages/core/smoke/payment/one.test.ts", "Synthetic witness");
    const projection = collectOutcomeProjection(root);
    const rendered = renderOutcomeProjection(projection);
    expect(projection.outcomes).toHaveLength(2);
    expect(rendered).toContain("| `@openlup/core@0.36.0/payment` | 2 |");
    expect(rendered).toContain("../../packages/core/smoke/payment");
    expect(rendered).not.toContain("provider-one");
    expect(rendered).not.toContain("provider-two");
    expect(rendered).toContain("| missing |");
  });

  it("checks exact generated bytes and refuses a complete claim even when fresh", () => {
    const { root, put } = fixture();
    put("docs/platform/OUTCOME_PROJECTION.md", "Stale output");
    expect(() => runOutcomeProjection(root, ["--check"])).toThrow(/stale output/u);
    runOutcomeProjection(root, ["--write"]);
    expect(() => runOutcomeProjection(root, ["--check"])).not.toThrow();
    expect(() => runOutcomeProjection(root, ["--assert-complete"])).toThrow(/partial evidence blocks/u);
    expect(() => runOutcomeProjection(root, ["--write", "--check"])).toThrow(/Use/u);
  });

  it("refuses a proof reached through a directory symlink outside its package", () => {
    const { root, put } = fixture();
    put("outside/subscription.test.ts", "External witness");
    rmSync(join(root, "packages/core/smoke"), { recursive: true });
    symlinkSync(join(root, "outside"), join(root, "packages/core/smoke"), "dir");
    expect(() => collectOutcomeProjection(root)).toThrow(/proof escaped package/u);
  });

  it("projects the real package set with zero new UI neutrality counts", () => {
    const root = resolve(import.meta.dirname, "..");
    const projection = collectOutcomeProjection(root);
    const rendered = renderOutcomeProjection(projection);
    const result = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts", "--counts-json"], {
      cwd: root, input: JSON.stringify([{ path: "docs/platform/OUTCOME_PROJECTION.md", contents: rendered }]), encoding: "utf8", timeout: 10_000,
    }));
    expect(result.counts[0].counts).toEqual({});
    const classCount = [...rendered.matchAll(/^\| `[^`]+` \| (\d+) \|/gmu)].reduce((sum, match) => sum + Number(match[1]), 0);
    expect(classCount).toBe(projection.outcomes.length);
    expect(projection.claimable).toBe(false);
    expect(readFileSync(join(root, "docs/platform/OUTCOME_PROJECTION.md"), "utf8")).toBe(rendered);
    const cli = resolve(root, "scripts/generate-outcome-projection-cli.ts");
    expect(() => execFileSync(process.execPath, ["--experimental-strip-types", cli, "--check"], { encoding: "utf8", timeout: 10_000 })).not.toThrow();
    expect(() => execFileSync(process.execPath, ["--experimental-strip-types", cli, "--assert-complete"], { encoding: "utf8", stdio: "pipe", timeout: 10_000 })).toThrow();
  });
});
